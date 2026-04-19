'use client';

/**
 * Ember swap widget.
 * User types a trade in English, agent builds it, user signs from their wallet.
 * Non-custodial, on Base.
 */

import { useState, useCallback } from 'react';

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

type Stage =
  | 'idle'
  | 'connecting'
  | 'loading'
  | 'signing_approvals'
  | 'signing_swap'
  | 'confirming'
  | 'done'
  | 'error';

interface ExecuteResult {
  // EVM (Base) fields
  transaction?: { to: string; data: string; value: string; chainId: number };
  approvals?: { to: string; data: string; value: string }[];
  explorer_base?: string;
  // Solana (Jupiter) fields
  chain?: 'solana';
  swapTransaction?: string;           // Base64-encoded VersionedTransaction
  lastValidBlockHeight?: number;
  quote?: { inAmountFormatted: string; outAmountFormatted: string; priceImpact: string; slippageBps: number };
  // Common
  trade_id: string;
  builder_code?: string | null;
  intent: any;
  compute_cost_usd: number;
  message: string;
}

/** Get Phantom Solana provider */
function getPhantom(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).phantom?.solana ?? (window as any).solana ?? null;
}

export default function TryItWidget() {
  const [command, setCommand] = useState('Buy $0.10 ETH');
  const [stage, setStage] = useState<Stage>('idle');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [, setExecuteResult] = useState<ExecuteResult | null>(null);
  const [swapTxHash, setSwapTxHash] = useState<string | null>(null);
  const [confirmResult, setConfirmResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [intentSide, setIntentSide] = useState<string | null>(null);

  const connectWallet = useCallback(async () => {
    setStage('connecting');
    setError('');
    try {
      if (typeof window === 'undefined' || !(window as any).ethereum) {
        throw new Error('No EVM wallet found. Install MetaMask, Phantom, or Rabby.');
      }
      const ethereum = (window as any).ethereum;
      const accounts: string[] = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts.length) throw new Error('No accounts returned from wallet');
      setWalletAddress(accounts[0]);
      setStage('idle');
      return accounts[0];
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
      return null;
    }
  }, []);

  async function handleSendCommand() {
    setStage('loading');
    setError('');
    setExecuteResult(null);
    setSwapTxHash(null);
    setConfirmResult(null);
    setIntentSide(null);

    let addr = walletAddress;
    if (!addr) {
      addr = await connectWallet();
      if (!addr) return;
    }

    try {
      // Check if Phantom is available for Solana wallet address
      let solanaWalletAddress: string | undefined;
      const phantom = getPhantom();
      if (phantom?.isPhantom && phantom.publicKey) {
        solanaWalletAddress = phantom.publicKey.toString();
      }

      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, walletAddress: addr, solanaWalletAddress }),
      });

      if (!res.ok) {
        const data = await res.json();
        // If Solana wallet needed but not connected, try to connect Phantom
        if (data.error?.includes('Solana wallet required')) {
          const connected = await connectPhantom();
          if (connected) {
            // Retry with Phantom connected
            const retryRes = await fetch('/api/execute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command, walletAddress: addr, solanaWalletAddress: connected }),
            });
            if (!retryRes.ok) {
              const retryData = await retryRes.json();
              throw new Error(retryData.error || `HTTP ${retryRes.status}`);
            }
            const retryData: ExecuteResult = await retryRes.json();
            setExecuteResult(retryData);
            setIntentSide(retryData.intent?.side ?? null);
            if (retryData.chain === 'solana') {
              await signSolanaSwap(retryData);
            } else {
              await signAndBroadcast(retryData, addr);
            }
            return;
          }
          throw new Error('Phantom wallet not found. Install Phantom to swap Solana tokens.');
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data: ExecuteResult = await res.json();
      setExecuteResult(data);
      setIntentSide(data.intent?.side ?? null);

      if (data.chain === 'solana') {
        await signSolanaSwap(data);
      } else {
        await signAndBroadcast(data, addr);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }

  async function connectPhantom(): Promise<string | null> {
    const phantom = getPhantom();
    if (!phantom?.isPhantom) return null;
    try {
      const resp = await phantom.connect();
      return resp.publicKey.toString();
    } catch {
      return null;
    }
  }

  async function signSolanaSwap(result: ExecuteResult) {
    const phantom = getPhantom();
    if (!phantom?.isPhantom) {
      setError('Phantom wallet not found. Install Phantom to swap Solana tokens.');
      setStage('error');
      return;
    }

    try {
      setStage('signing_swap');
      setStatusMsg('Confirm the Solana swap in Phantom…');

      // Deserialize the base64 transaction.
      // Jupiter swaps → VersionedTransaction; native SOL/SPL transfers → legacy Transaction.
      const { VersionedTransaction, Transaction } = await import('@solana/web3.js');
      const txBuffer = Uint8Array.from(atob(result.swapTransaction!), (c) => c.charCodeAt(0));
      let transaction: any;
      try {
        transaction = VersionedTransaction.deserialize(txBuffer);
      } catch {
        // Legacy transaction (e.g. SOL/SPL transfer built with buildSolanaTransfer)
        transaction = Transaction.from(txBuffer);
      }

      // Sign and send via Phantom
      const { signature } = await phantom.signAndSendTransaction(transaction);
      setSwapTxHash(signature);
      setStatusMsg('Solana transaction sent! Confirming…');
      setStage('confirming');

      // Wait for confirmation via Solana RPC
      const { Connection } = await import('@solana/web3.js');
      const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

      // VersionedTransaction: .message.recentBlockhash
      // Legacy Transaction:   .recentBlockhash
      const blockhash =
        (transaction as any).message?.recentBlockhash ??
        (transaction as any).recentBlockhash ??
        '';
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight ?? 0,
      }, 'confirmed');

      // Record confirmation
      await fetch('/api/execute/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: result.trade_id, tx_hash: signature }),
      });

      setConfirmResult({ tx_hash: signature, explorer_url: `https://solscan.io/tx/${signature}` });
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }

  async function signAndBroadcast(result: ExecuteResult, addr: string) {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      setError('No EVM wallet found. Install MetaMask, Phantom, Rabby, or similar.');
      setStage('error');
      return;
    }

    try {
      setStatusMsg('Checking network…');
      await ensureBaseChain(ethereum);

      if (result.approvals && result.approvals.length > 0) {
        setStage('signing_approvals');
        setStatusMsg(`Signing ${result.approvals.length} approval(s)…`);
        for (let i = 0; i < result.approvals.length; i++) {
          setStatusMsg(`Signing approval ${i + 1}/${result.approvals.length}…`);
          const approval = result.approvals[i];
          const approvalTxHash = await ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from: addr, to: approval.to, data: approval.data, value: '0x0' }],
          });
          setStatusMsg(`Approval ${i + 1} sent: ${approvalTxHash.slice(0, 10)}…`);
          await waitForTx(approvalTxHash);
          setStatusMsg(`Approval ${i + 1} confirmed`);
        }
      }

      setStage('signing_swap');
      setStatusMsg(`Confirm the ${result.intent?.side === 'SEND' ? 'transfer' : 'swap'} in your wallet…`);
      const tx = result.transaction!;

      const swapHash: string = await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: addr, to: tx.to, data: tx.data, value: tx.value }],
      });
      setSwapTxHash(swapHash);
      setStatusMsg('Transaction sent. Waiting for confirmation…');
      setStage('confirming');

      await waitForTx(swapHash);

      setStatusMsg('Finalizing…');
      const confirmRes = await fetch('/api/execute/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade_id: result.trade_id, tx_hash: swapHash }),
      });
      const confirmData = await confirmRes.json();
      setConfirmResult(confirmData);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }

  async function waitForTx(hash: string, maxAttempts = 30): Promise<void> {
    const ethereum = (window as any).ethereum;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const receipt = await ethereum.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        });
        if (receipt) return;
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  function reset() {
    setStage('idle');
    setExecuteResult(null);
    setSwapTxHash(null);
    setConfirmResult(null);
    setError('');
    setStatusMsg('');
    setIntentSide(null);
  }

  const isSend = intentSide === 'SEND';
  const opLabel = isSend ? 'Transfer' : 'Swap';

  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;

  const isProcessing = ['loading', 'signing_approvals', 'signing_swap', 'confirming'].includes(stage);

  const canType = stage === 'idle' || stage === 'error';

  return (
    <div className="w-full max-w-3xl mx-auto space-y-5">
      {/* ─── Input ────────────────────────────────────────────────────── */}
      <div className="card !rounded-2xl !p-0 flex items-center gap-3 overflow-hidden focus-within:border-[rgba(255,122,61,0.4)] transition-colors">
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={!canType}
          placeholder='e.g. "Swap $5 ETH to USDC" or "Send $1 ETH to 0x..."'
          className="flex-1 bg-transparent text-[15px] text-[var(--color-text)] placeholder:text-[var(--color-text-mute)] outline-none py-4 pl-5"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canType) handleSendCommand();
          }}
        />
        {walletAddress ? (
          <button onClick={handleSendCommand} disabled={!canType} className="btn-primary !rounded-xl mr-2">
            Execute
          </button>
        ) : (
          <button onClick={connectWallet} disabled={stage === 'connecting'} className="btn-primary !rounded-xl mr-2">
            {stage === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>

      {/* ─── Preset chips ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {[
          'Buy $1 ETH',
          'Swap $5 ETH to USDC',
          'Swap 10 USDC to ETH',
          'Buy $5 SOL',
          'Send $1 ETH to 0x',
        ].map((label) => (
          <button key={label} onClick={() => setCommand(label)} disabled={!canType} className="chip disabled:opacity-40">
            {label}
          </button>
        ))}
      </div>

      {/* ─── Wallet status ─────────────────────────────────────────── */}
      {walletAddress && (
        <div className="flex items-center justify-center gap-2 text-[11px] text-[var(--color-text-mute)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-up)] pulse-dot" />
          <span className="mono">{shortWallet}</span>
          <span>·</span>
          <span>Base Network</span>
        </div>
      )}

      {/* ─── Loading ───────────────────────────────────────────────── */}
      {stage === 'loading' && (
        <div className="card !rounded-2xl p-5 flex items-center justify-center gap-3">
          <div className="w-4 h-4 border-2 border-[var(--color-border-strong)] border-t-[var(--color-accent)] rounded-full animate-spin" />
          <span className="text-[14px] text-[var(--color-text-dim)]">Building your transaction…</span>
        </div>
      )}

      {/* ─── Signing / Confirming ──────────────────────────────────── */}
      {(stage === 'signing_approvals' || stage === 'signing_swap' || stage === 'confirming') && (
        <div className="card !rounded-2xl p-5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border-2 border-[var(--color-border-strong)] border-t-[var(--color-accent)] rounded-full animate-spin" />
            <div className="flex-1">
              <p className="text-[14px] font-medium text-[var(--color-text)]">
                {stage === 'signing_approvals' && 'Approve Token Access'}
                {stage === 'signing_swap' && `Confirm ${opLabel}`}
                {stage === 'confirming' && 'Confirming Transaction'}
              </p>
              <p className="text-[12px] text-[var(--color-text-mute)] mt-0.5">{statusMsg}</p>
            </div>
          </div>
          {swapTxHash && (
            <div className="flex items-center gap-2 mt-4 rounded-xl px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)]">
              <span className="label">TX</span>
              <span className="mono text-[11px] text-[var(--color-text-dim)] truncate">{swapTxHash}</span>
            </div>
          )}
        </div>
      )}

      {/* ─── Success ───────────────────────────────────────────────── */}
      {stage === 'done' && (confirmResult || swapTxHash) && (
        <div className="space-y-3">
          <div className="card !rounded-2xl p-5 border-[rgba(74,222,128,0.25)]">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-[rgba(74,222,128,0.12)] flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-up)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div>
                <p className="text-[15px] font-medium text-[var(--color-text)]">{opLabel} Successful</p>
                <p className="text-[12px] text-[var(--color-text-mute)]">Executed from your wallet</p>
              </div>
            </div>

            <div className="space-y-2 text-[13px] pt-3 border-t border-[var(--color-border)]">
              {swapTxHash && (
                <div className="flex justify-between items-center">
                  <span className="text-[var(--color-text-mute)]">Transaction</span>
                  <span className="mono text-[12px] text-[var(--color-text-dim)]">
                    {swapTxHash.slice(0, 10)}…{swapTxHash.slice(-6)}
                  </span>
                </div>
              )}
              {confirmResult?.status && (
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-mute)]">Status</span>
                  <span className="pill pill-up text-[11px]">{confirmResult.status}</span>
                </div>
              )}
              {confirmResult?.gas_cost_usd !== undefined && (
                <div className="flex justify-between">
                  <span className="text-[var(--color-text-mute)]">Gas Cost</span>
                  <span className="mono text-[var(--color-text-dim)]">${confirmResult.gas_cost_usd.toFixed(6)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-3">
            {confirmResult?.explorer_url && (
              <a href={confirmResult.explorer_url} target="_blank" rel="noopener noreferrer" className="btn-secondary flex-1 text-center !rounded-xl">
                View on Explorer
              </a>
            )}
            <button onClick={reset} className="btn-primary flex-1 !rounded-xl">New Transaction</button>
          </div>
        </div>
      )}

      {/* ─── Error ─────────────────────────────────────────────────── */}
      {stage === 'error' && error && (
        <div className="card !rounded-2xl p-4 border-[rgba(251,113,133,0.25)]">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-[rgba(251,113,133,0.12)] flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-down)" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <p className="text-[13px] text-[var(--color-down)] break-words flex-1">{error}</p>
            <button onClick={reset} className="text-[12px] font-medium text-[var(--color-text-mute)] hover:text-[var(--color-text)] transition-colors">
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
