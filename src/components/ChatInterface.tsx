'use client';

import { useState, useRef, useEffect } from 'react';
import { ethers } from 'ethers';
import { ChatMessage, TradeIntent, Quote, GuardrailResult } from '@/src/lib/types';
import { parseTradeIntent } from '@/src/lib/llm';
import { checkGuardrails } from '@/src/lib/policy';
import { saveTrade, updateTradeStatus } from '@/src/lib/storage';
import MessageList from './MessageList';
import TradeReviewModal from './TradeReviewModal';
import type { ReceiptSummary } from '@/src/lib/types';

const BASE_CHAIN_ID_HEX = '0x2105'; // 8453

async function ensureBaseChain(ethereum: any): Promise<void> {
  const currentHex: string = await ethereum.request({ method: 'eth_chainId' });
  if (currentHex?.toLowerCase() === BASE_CHAIN_ID_HEX) return;

  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (switchError: any) {
    if (switchError?.code === 4902) {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: BASE_CHAIN_ID_HEX,
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org'],
        }],
      });
    } else if (switchError?.code === 4001 || switchError?.code === 'ACTION_REJECTED') {
      throw new Error('Please switch your wallet to Base to continue.');
    } else {
      throw switchError;
    }
  }
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [reviewModal, setReviewModal] = useState<{
    intent: TradeIntent;
    quote: Quote;
    guardrails: GuardrailResult;
  } | null>(null);
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Get wallet address from MetaMask
    const getWalletAddress = async () => {
      if (typeof window === 'undefined' || typeof (window as any).ethereum === 'undefined') {
        return;
      }

      try {
        const ethProvider = new ethers.BrowserProvider((window as any).ethereum);
        setProvider(ethProvider);
        const accounts = await ethProvider.listAccounts();
        if (accounts.length > 0) {
          const signer = await ethProvider.getSigner();
          const address = await signer.getAddress();
          setWalletAddress(address);
          
          // Log wallet ETH balance
          try {
            const balance = await ethProvider.getBalance(address);
            const balanceFormatted = ethers.formatEther(balance);
            console.log('[ChatInterface] 💰 Wallet Connected - ETH Balance:');
            console.log('[ChatInterface]   - Address:', address);
            console.log('[ChatInterface]   - Balance (raw):', balance.toString());
            console.log('[ChatInterface]   - Balance (formatted):', balanceFormatted, 'ETH');
          } catch (balanceError) {
            console.warn('[ChatInterface] ⚠️ Could not fetch wallet ETH balance:', balanceError);
          }
        }
      } catch (error) {
        console.error('Error getting wallet address:', error);
      }
    };

    getWalletAddress();

    // Listen for account changes
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      (window as any).ethereum.on('accountsChanged', async (accounts: string[]) => {
        if (accounts.length > 0) {
          const newAddress = accounts[0];
          setWalletAddress(newAddress);
          
          // Log wallet ETH balance when account changes
          try {
            const ethProvider = new ethers.BrowserProvider((window as any).ethereum);
            const balance = await ethProvider.getBalance(newAddress);
            const balanceFormatted = ethers.formatEther(balance);
            console.log('[ChatInterface] 💰 Account Changed - ETH Balance:');
            console.log('[ChatInterface]   - New Address:', newAddress);
            console.log('[ChatInterface]   - Balance (raw):', balance.toString());
            console.log('[ChatInterface]   - Balance (formatted):', balanceFormatted, 'ETH');
          } catch (balanceError) {
            console.warn('[ChatInterface] ⚠️ Could not fetch wallet ETH balance:', balanceError);
          }
        } else {
          setWalletAddress('');
          setProvider(null);
        }
      });
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addMessage = (role: ChatMessage['role'], content: string, data?: Partial<ChatMessage>) => {
    const message: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      role,
      content,
      timestamp: Date.now(),
      ...data,
    };
    setMessages((prev) => [...prev, message]);
    return message;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = addMessage('user', input);
    setInput('');
    setLoading(true);

    try {
      if (!walletAddress) {
        addMessage('assistant', 'Please connect your MetaMask wallet first.');
        setLoading(false);
        return;
      }

      // Log wallet ETH balance before processing command
      if (provider) {
        try {
          // Log network info
          const network = await provider.getNetwork();
          console.log('[ChatInterface] 🌐 Network Info:');
          console.log('[ChatInterface]   - Network:', network.name);
          console.log('[ChatInterface]   - Chain ID:', network.chainId.toString());
          
          const balance = await provider.getBalance(walletAddress);
          const balanceFormatted = ethers.formatEther(balance);
          console.log('[ChatInterface] 💰 Wallet ETH Balance (before command):');
          console.log('[ChatInterface]   - Address:', walletAddress);
          console.log('[ChatInterface]   - Balance (raw):', balance.toString());
          console.log('[ChatInterface]   - Balance (formatted):', balanceFormatted, 'ETH');
          console.log('[ChatInterface]   - Network:', network.name, '(Chain ID:', network.chainId.toString() + ')');
        } catch (balanceError) {
          console.warn('[ChatInterface] ⚠️ Could not fetch wallet ETH balance:', balanceError);
          if (balanceError instanceof Error) {
            console.warn('[ChatInterface]   - Error message:', balanceError.message);
            console.warn('[ChatInterface]   - Error stack:', balanceError.stack);
          }
        }
      }

      // Parse intent via backend server (has access to OPENAI_API_KEY)
      // Use the backend server's /interpret endpoint
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000';
      const parseUrl = `${backendUrl}/interpret`;
      console.log('[ChatInterface] Parsing command via backend:', input);
      console.log('[ChatInterface] Backend URL:', parseUrl);
      console.log('[ChatInterface] Current origin:', typeof window !== 'undefined' ? window.location.origin : 'server-side');
      
      const parseResponse = await fetch(parseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: input }),
      });

      if (!parseResponse.ok) {
        const errorData = await parseResponse.json();
        console.error('[ChatInterface] Parse API error:', errorData);
        const errorMsg = errorData.error || errorData.checks?.errors?.join(', ') || 'Could not parse your command';
        addMessage('assistant', errorMsg);
        setLoading(false);
        return;
      }

      const parseData = await parseResponse.json();
      
      console.log('[ChatInterface] ========================================');
      console.log('[ChatInterface] BACKEND RESPONSE:');
      console.log('[ChatInterface]   - Full parseData:', JSON.stringify(parseData, null, 2));
      
      // Backend returns { intent, checks } format
      const intent = parseData.intent;
      console.log('[ChatInterface] Backend Intent (raw):');
      console.log('[ChatInterface]   - Action:', intent?.action);
      console.log('[ChatInterface]   - From Token:', intent?.fromToken);
      console.log('[ChatInterface]   - To Token:', intent?.toToken);
      console.log('[ChatInterface]   - Amount Type:', intent?.amountType);
      console.log('[ChatInterface]   - Amount:', intent?.amount);
      console.log('[ChatInterface]   - Chain ID:', intent?.chainId);
      console.log('[ChatInterface]   - Slippage:', intent?.slippageBps);
      
      if (!intent || !parseData.checks?.valid) {
        const errors = parseData.checks?.errors || ['Failed to parse intent'];
        console.error('[ChatInterface] Parse failed:', errors);
        addMessage('assistant', errors.join('. ') || 'Could not parse your command. Try: "Buy $100 ETH", "Sell 0.05 ETH", or "Swap 50 USDC to ETH"');
        setLoading(false);
        return;
      }

      // Convert backend Intent format to frontend TradeIntent format
      const tradeIntent: TradeIntent = {
        side: intent.action === 'BUY' ? 'BUY' : intent.action === 'SELL' ? 'SELL' : 'SWAP',
        amountUsd: intent.amountType === 'USD' ? intent.amount : undefined,
        amountToken: intent.amountType === 'TOKEN' ? intent.amount : undefined,
        tokenInSymbol: intent.fromToken,
        tokenOutSymbol: intent.toToken,
        slippageBps: intent.slippageBps,
        chainId: intent.chainId,
      };

      console.log('[ChatInterface] ========================================');
      console.log('[ChatInterface] CONVERTED TradeIntent:');
      console.log('[ChatInterface]   - Side:', tradeIntent.side);
      console.log('[ChatInterface]   - Token In:', tradeIntent.tokenInSymbol);
      console.log('[ChatInterface]   - Token Out:', tradeIntent.tokenOutSymbol);
      console.log('[ChatInterface]   - Amount USD:', tradeIntent.amountUsd || 'N/A');
      console.log('[ChatInterface]   - Amount Token:', tradeIntent.amountToken || 'N/A');
      console.log('[ChatInterface]   - Slippage:', tradeIntent.slippageBps, 'bps');
      console.log('[ChatInterface]   - Chain ID:', tradeIntent.chainId);
      console.log('[ChatInterface] Full TradeIntent object:', JSON.stringify(tradeIntent, null, 2));
      console.log('[ChatInterface] ========================================');
      
      // CRITICAL VALIDATION: Check if conversion is correct
      if (intent.amountType === 'USD' && intent.fromToken === 'USDC') {
        console.log('[ChatInterface] ✅ Validation: USD amount with USDC input - conversion should be correct');
        console.log('[ChatInterface]   - Expected: amountUsd =', intent.amount, ', amountToken = undefined');
        console.log('[ChatInterface]   - Actual: amountUsd =', tradeIntent.amountUsd, ', amountToken =', tradeIntent.amountToken);
        if (tradeIntent.amountUsd !== intent.amount) {
          console.error('[ChatInterface] ❌❌❌ CRITICAL: amountUsd mismatch!');
        }
        if (tradeIntent.amountToken !== undefined) {
          console.error('[ChatInterface] ❌❌❌ CRITICAL: amountToken should be undefined but is:', tradeIntent.amountToken);
        }
      } else if (intent.amountType === 'TOKEN' && intent.fromToken === 'ETH') {
        console.log('[ChatInterface] ⚠️ WARNING: TOKEN amount with ETH input - this might be the issue!');
        console.log('[ChatInterface]   - This means the backend parsed it as "1 ETH" instead of "$1 USD"');
      }

      // Format message - clarify that ETH is native ETH, not WETH
      const fromTokenDisplay = tradeIntent.tokenInSymbol === 'ETH' 
        ? 'ETH (native)' 
        : tradeIntent.tokenInSymbol;
      addMessage('assistant', `Parsed: ${tradeIntent.side} ${tradeIntent.amountUsd ? `$${tradeIntent.amountUsd}` : `${tradeIntent.amountToken} ${fromTokenDisplay}`} → ${tradeIntent.tokenOutSymbol}`, { tradeIntent });

      // Get quote
      addMessage('assistant', 'Getting quote...');

      const quoteResponse = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: tradeIntent, walletAddress }),
      });

      if (!quoteResponse.ok) {
        const errorData = await quoteResponse.json();
        throw new Error(errorData.error || 'Failed to get quote');
      }

      const quote = await quoteResponse.json() as Quote;

      // Format quote message - clarify that ETH is native ETH
      const tokenInDisplay = tradeIntent.tokenInSymbol === 'ETH' 
        ? 'ETH (native)' 
        : tradeIntent.tokenInSymbol;
      addMessage('assistant', `Quote received: ${quote.amountInFormatted} ${tokenInDisplay} → ${quote.amountOutFormatted} ${tradeIntent.tokenOutSymbol} (min: ${quote.minAmountOutFormatted})`, { quote });

      // Check guardrails
      const guardrails = checkGuardrails(tradeIntent, quote);

      // Show review modal
      setReviewModal({ intent: tradeIntent, quote, guardrails });
    } catch (error) {
      addMessage('assistant', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmTrade = async () => {
    if (!reviewModal || !walletAddress || !provider) return;

    setLoading(true);

    try {
      // Force wallet onto Base before anything else — the swap tx is Base-specific
      const ethereum = (window as any).ethereum;
      if (!ethereum) throw new Error('No EVM wallet found. Install MetaMask, Phantom, Rabby, or similar.');
      addMessage('assistant', 'Checking network…');
      await ensureBaseChain(ethereum);

      // Build swap transaction
      let buildResponse = await fetch('/api/buildSwap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: reviewModal.intent,
          quote: reviewModal.quote,
          walletAddress,
        }),
      });


      if (!buildResponse.ok) {
        const errorData = await buildResponse.json();
        throw new Error(errorData.error || 'Failed to build transaction');
      }

      const txRequest = await buildResponse.json() as { 
        to: string; 
        data: string; 
        value: string; 
        chainId: number; 
        gas?: string; 
        deadline: number;
        needsApproval?: boolean;
        approvalTransactions?: Array<{
          to: string;
          data: string;
          value: string;
          chainId: number;
          label: string;
          tokenSymbol: string;
          tokenAddress: string;
          spender: string;
          amount: string;
        }>;
        // Legacy single approval
        approvalTransaction?: {
          to: string;
          data: string;
          value: string;
          chainId: number;
          tokenSymbol: string;
          tokenAddress: string;
          spender: string;
          amount: string;
          label?: string;
        };
      };
      
      // Handle approvals if needed (V4 Permit2 may require 2 approvals)
      const approvals = txRequest.approvalTransactions 
        || (txRequest.approvalTransaction ? [txRequest.approvalTransaction] : []);
      
      if (approvals.length > 0) {
        const signer = await provider.getSigner();
        
        for (let i = 0; i < approvals.length; i++) {
          const approval = approvals[i];
          const label = approval.label || `Approve ${approval.tokenSymbol}`;
          addMessage('assistant', `🔑 Step ${i + 1}/${approvals.length}: ${label}. Please confirm in MetaMask...`);
          
          const approvalTx = await signer.sendTransaction({
            to: approval.to,
            data: approval.data,
            value: approval.value,
          });
          
          addMessage('assistant', `Approval tx submitted: ${approvalTx.hash}. Waiting for confirmation...`);
          
          const approvalReceipt = await approvalTx.wait(1);
          if (approvalReceipt) {
            addMessage('assistant', `✅ Approval ${i + 1}/${approvals.length} confirmed!`);
          } else {
            throw new Error(`Approval transaction ${i + 1} failed`);
          }
        }
        
        addMessage('assistant', '✅ All approvals confirmed! Proceeding with swap...');
      }

      {
        // Regular transaction signing via MetaMask
        addMessage('assistant', 'Please confirm the transaction in MetaMask...');
        const signer = await provider.getSigner();
        
          try {
            // Try to estimate gas first to catch errors early
            try {
              console.log('[ChatInterface] ========================================');
              console.log('[ChatInterface] PRE-FLIGHT GAS ESTIMATION:');
              console.log('[ChatInterface]   - To:', txRequest.to);
              console.log('[ChatInterface]   - From:', walletAddress);
              console.log('[ChatInterface]   - Value:', txRequest.value, `(${txRequest.value === '0x0' ? '0 ETH' : ethers.formatEther(txRequest.value) + ' ETH'})`);
              console.log('[ChatInterface]   - Data Length:', txRequest.data.length, 'chars');
              console.log('[ChatInterface]   - Chain ID:', txRequest.chainId);
              console.log('[ChatInterface] Estimating gas...');
              
              const estimatedGas = await provider.estimateGas({
                to: txRequest.to,
                data: txRequest.data,
                value: txRequest.value,
                from: walletAddress,
              });
              console.log('[ChatInterface] ✅ Gas estimate:', estimatedGas.toString());
              console.log('[ChatInterface] ========================================');
            } catch (estimateError) {
              const errorMsg = estimateError instanceof Error ? estimateError.message : String(estimateError);
              console.error('[ChatInterface] ========================================');
              console.error('[ChatInterface] ❌ GAS ESTIMATION FAILED:');
              console.error('[ChatInterface]   - Error Type:', estimateError instanceof Error ? estimateError.constructor.name : typeof estimateError);
              console.error('[ChatInterface]   - Error Message:', errorMsg);
              
              // Log full error details
              if (estimateError instanceof Error) {
                console.error('[ChatInterface]   - Error Stack:', estimateError.stack);
                const errorAny = estimateError as any;
                if (errorAny.info) {
                  console.error('[ChatInterface]   - Error Info:', JSON.stringify(errorAny.info, null, 2));
                }
                if (errorAny.data) {
                  console.error('[ChatInterface]   - Error Data:', errorAny.data);
                }
                if (errorAny.reason) {
                  console.error('[ChatInterface]   - Revert Reason:', errorAny.reason);
                }
                if (errorAny.transaction) {
                  console.error('[ChatInterface]   - Failed Transaction:', JSON.stringify(errorAny.transaction, null, 2));
                }
              }
              
              console.error('[ChatInterface]   - Transaction Details:');
              console.error('[ChatInterface]     * To:', txRequest.to);
              console.error('[ChatInterface]     * From:', walletAddress);
              console.error('[ChatInterface]     * Value:', txRequest.value, `(${txRequest.value === '0x0' ? '0 ETH' : ethers.formatEther(txRequest.value) + ' ETH'})`);
              console.error('[ChatInterface]     * Data (first 200 chars):', txRequest.data.slice(0, 200));
              console.error('[ChatInterface]     * Chain ID:', txRequest.chainId);
              console.error('[ChatInterface] ========================================');
              
              // Try to extract more details from the error
              let detailedError = errorMsg;
              if (errorMsg.includes('missing revert data') || errorMsg.includes('CALL_EXCEPTION')) {
                // Check if this is likely an amount-too-small issue
                const txValue = txRequest.value ? BigInt(txRequest.value) : BigInt(0);
                detailedError = 'Transaction would revert. This usually means:\n' +
                  '1. Missing token approval - The router needs permission to spend your tokens\n' +
                  '2. Insufficient balance - You don\'t have enough tokens\n' +
                  '3. Invalid pool - The trading pair may not exist on Base\n' +
                  '4. Wrong router address - The router address may be incorrect\n' +
                  '5. Wrong fee tier - The pool may not exist for the selected fee tier\n\n' +
                  'Please check your token balance and approve the router if needed.';
              } else if (errorMsg.includes('execution reverted') || errorMsg.includes('revert')) {
                detailedError = 'Transaction would revert. Common issues:\n' +
                  '- Missing token approval\n' +
                  '- Insufficient balance\n' +
                  '- Invalid swap parameters\n' +
                  '- Pool does not exist for this token pair/fee tier\n\n' +
                  'Please check your token balance and approvals.';
              } else if (errorMsg.includes('insufficient funds')) {
                detailedError = 'Insufficient funds for gas + transaction value.\n' +
                  `Transaction value: ${txRequest.value === '0x0' ? '0 ETH' : ethers.formatEther(txRequest.value) + ' ETH'}\n` +
                  'Please ensure you have enough ETH for gas fees.';
              }
            
            addMessage('assistant', `⚠️ ${detailedError}`);
            setLoading(false);
            return;
          }
          
          // Verify builder code is present before sending
          if (txRequest.data) {
            const dataEnd = txRequest.data.slice(-32).toLowerCase();
            const hasBuilderCode = dataEnd.includes('8021');
            console.log('[ChatInterface] Builder code check:', {
              dataLength: txRequest.data.length,
              dataEnd,
              hasBuilderCode: hasBuilderCode ? '✅ Present' : '❌ Missing',
            });
            if (!hasBuilderCode) {
              console.warn('[ChatInterface] ⚠️ WARNING: Builder code suffix not detected in transaction data!');
            }
          }
          
          const tx = await signer.sendTransaction({
            to: txRequest.to,
            data: txRequest.data,
            value: txRequest.value,
            gasLimit: txRequest.gas ? BigInt(txRequest.gas) : undefined,
          });

          // Broadcast (transaction is already sent by MetaMask)
          addMessage('assistant', `Transaction submitted! Hash: ${tx.hash}`, { txHash: tx.hash });

        // Save to history
        const tradeId = `trade_${Date.now()}`;
        saveTrade({
          id: tradeId,
          timestamp: Date.now(),
          intent: reviewModal.intent,
          quote: reviewModal.quote,
          txHash: tx.hash,
          status: 'pending',
        });

        // Wait for receipt
        addMessage('assistant', 'Waiting for confirmation...');
        const receipt = await tx.wait(1);

        if (receipt) {
          // Get explorer URL for Base
          const { getChainId } = await import('@/src/lib/rpc');
          const chainId = getChainId();
          const explorerUrl = chainId === 8453 
            ? `https://basescan.org/tx/${receipt.hash}`
            : `https://basescan.org/tx/${receipt.hash}`;
          
          // Try to decode the actual amount received from transaction logs
          let actualAmountOut = reviewModal.quote.amountOutFormatted; // Fallback to quote
          try {
            // Decode Transfer event from WETH to recipient
            const wethAddress = '0x4200000000000000000000000000000000000006'; // Base WETH
            const transferEventSignature = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
            
            // Find Transfer event from router to recipient
            for (const log of receipt.logs || []) {
              if (log.address.toLowerCase() === wethAddress.toLowerCase() && 
                  log.topics[0] === transferEventSignature &&
                  log.topics[2]?.toLowerCase() === walletAddress.toLowerCase().replace('0x', '0x000000000000000000000000')) {
                // Decode amount from data (last 32 bytes)
                const amountHex = log.data;
                if (amountHex && amountHex.length >= 66) {
                  const amountBigInt = BigInt(amountHex);
                  actualAmountOut = ethers.formatEther(amountBigInt);
                  console.log('[ChatInterface] ✅ Decoded actual WETH received:', actualAmountOut, 'WETH');
                  break;
                }
              }
            }
          } catch (decodeError) {
            console.warn('[ChatInterface] Could not decode amount from logs, using quote:', decodeError);
          }
          
          const receiptSummary: ReceiptSummary = {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber || 0,
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status === 1 ? 'success' : 'failed',
            explorerUrl,
            fromToken: reviewModal.intent.tokenInSymbol,
            toToken: reviewModal.intent.tokenOutSymbol,
            amountIn: reviewModal.quote.amountInFormatted,
            amountOut: reviewModal.quote.amountOutFormatted,
          };

          updateTradeStatus(tradeId, receiptSummary.status === 'success' ? 'confirmed' : 'failed', receiptSummary);
          addMessage('assistant', `Transaction ${receiptSummary.status === 'success' ? 'confirmed' : 'failed'}!`, { txHash: receipt.hash });
        } else {
          addMessage('assistant', '⚠️ Transaction submitted but receipt not yet available');
        }
        } catch (txError) {
          const errorMsg = txError instanceof Error ? txError.message : String(txError);
          console.error('[ChatInterface] Transaction error:', txError);
          
          if (errorMsg.includes('execution reverted') || errorMsg.includes('revert')) {
            addMessage('assistant', `❌ Transaction reverted. This usually means:\n- Missing token approval (approve the router to spend your tokens)\n- Insufficient token balance\n- Invalid swap parameters\n- Pool does not exist for this token pair\n\nError: ${errorMsg}`);
          } else if (errorMsg.includes('user rejected') || errorMsg.includes('User denied')) {
            addMessage('assistant', 'Transaction cancelled by user.');
          } else if (errorMsg.includes('insufficient funds')) {
            addMessage('assistant', '❌ Insufficient funds for gas. Please add ETH to your wallet.');
          } else {
            addMessage('assistant', `❌ Transaction failed: ${errorMsg}`);
          }
          throw txError; // Re-throw to be caught by outer catch
        }
      }

      setReviewModal(null);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ChatInterface] Error in handleConfirmTrade:', error);
      
      // Don't show duplicate error messages
      if (!errorMsg.includes('Transaction reverted') && !errorMsg.includes('user rejected')) {
        addMessage('assistant', `Error: ${errorMsg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {!walletAddress && (
        <div className="mb-4 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <p className="text-sm text-trading-text">
            Please connect your MetaMask wallet to start trading.
          </p>
        </div>
      )}

      <MessageList messages={messages} />
      <div ref={messagesEndRef} />

      <form onSubmit={handleSubmit} className="mt-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a trading command (e.g., 'Buy $100 ETH')..."
            className="flex-1 input-field"
            disabled={loading || !walletAddress}
          />
          <button
            type="submit"
            disabled={loading || !input.trim() || !walletAddress}
            className="btn-primary"
          >
            {loading ? 'Processing...' : 'Send'}
          </button>
        </div>
      </form>

      {reviewModal && (
        <TradeReviewModal
          intent={reviewModal.intent}
          quote={reviewModal.quote}
          guardrails={reviewModal.guardrails}
          walletAddress={walletAddress}
          onConfirm={handleConfirmTrade}
          onCancel={() => setReviewModal(null)}
          loading={loading}
        />
      )}
    </div>
  );
}
