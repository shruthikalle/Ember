'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import PerpsReviewModal from './PerpsReviewModal';

// ─── Approve Agent flow (one-time MetaMask sig → server-side keypair) ───────
// Hyperliquid hardcodes chainId 1337 in EIP-712 domains for L1 actions
// (orders, leverage, etc), but MetaMask refuses to sign typed data when the
// active chain doesn't match. The standard fix is the "Approve Agent"
// pattern: user signs ONCE with their main wallet to authorize a programmatic
// agent keypair (chainId 42161 — works fine on Arbitrum). All subsequent
// orders are signed locally by the agent's privkey, no MetaMask popups.

const AGENT_PK_KEY = 'quasar_hl_agent_pk';
const AGENT_ADDR_KEY = 'quasar_hl_agent_addr';
const AGENT_OWNER_KEY = 'quasar_hl_agent_owner';

interface AgentInfo {
  privateKey: string;
  address: string;
}

function loadAgent(walletAddr: string): AgentInfo | null {
  if (typeof window === 'undefined') return null;
  const owner = localStorage.getItem(AGENT_OWNER_KEY);
  if (!owner || owner.toLowerCase() !== walletAddr.toLowerCase()) return null;
  const privateKey = localStorage.getItem(AGENT_PK_KEY);
  const address = localStorage.getItem(AGENT_ADDR_KEY);
  if (!privateKey || !address) return null;
  return { privateKey, address };
}

function saveAgent(walletAddr: string, info: AgentInfo) {
  localStorage.setItem(AGENT_OWNER_KEY, walletAddr.toLowerCase());
  localStorage.setItem(AGENT_PK_KEY, info.privateKey);
  localStorage.setItem(AGENT_ADDR_KEY, info.address);
}

function clearAgent() {
  localStorage.removeItem(AGENT_OWNER_KEY);
  localStorage.removeItem(AGENT_PK_KEY);
  localStorage.removeItem(AGENT_ADDR_KEY);
}

/**
 * Approve a freshly-generated agent keypair on Hyperliquid.
 * Pops MetaMask exactly once — typed data uses chainId 42161, which matches
 * Arbitrum, so MetaMask signs cleanly with no chainId mismatch.
 */
async function approveAgentWithMetaMask(walletAddr: string): Promise<AgentInfo> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) throw new Error('MetaMask not available');

  // Make sure we're on Arbitrum (typed-data domain chainId 42161)
  const currentHex: string = await ethereum.request({ method: 'eth_chainId' });
  if (currentHex?.toLowerCase() !== '0xa4b1') {
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0xa4b1' }],
      });
    } catch (switchErr: any) {
      if (switchErr?.code === 4902) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0xa4b1',
            chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://arb1.arbitrum.io/rpc'],
            blockExplorerUrls: ['https://arbiscan.io'],
          }],
        });
      } else {
        throw new Error('Please switch to Arbitrum One to set up your trading agent.');
      }
    }
  }

  // Generate the agent
  const { ethers } = await import('ethers');
  const agent = ethers.Wallet.createRandom();
  const nonce = Date.now();
  const agentName = `Quasar-${Math.floor(Math.random() * 9999)}`;

  // Build the EIP-712 typed data exactly the way Hyperliquid expects
  const message = {
    hyperliquidChain: 'Mainnet',
    agentAddress: agent.address.toLowerCase(),
    agentName,
    nonce,
  };

  const payload = {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: 42161,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message,
  };

  const sigHex: string = await ethereum.request({
    method: 'eth_signTypedData_v4',
    params: [walletAddr, JSON.stringify(payload)],
  });

  const sig = ethers.Signature.from(sigHex);

  // POST the action + signature to Hyperliquid
  const action = {
    type: 'approveAgent',
    signatureChainId: '0xa4b1',
    hyperliquidChain: 'Mainnet',
    agentAddress: agent.address.toLowerCase(),
    agentName,
    nonce,
  };

  const res = await fetch('https://api.hyperliquid.xyz/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      nonce,
      signature: { r: sig.r, s: sig.s, v: sig.v },
    }),
  });

  const result = await res.json();
  if (result.status !== 'ok') {
    console.error('[HL Agent] Approval rejected:', result);
    throw new Error(`Agent approval failed: ${result?.response || JSON.stringify(result)}`);
  }

  const info: AgentInfo = { privateKey: agent.privateKey, address: agent.address };
  saveAgent(walletAddr, info);
  return info;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface HLTradeParams {
  assetIndex: number;
  coin: string;
  side: 'LONG' | 'SHORT';
  size: string;
  price: string;
  leverage: number;
  szDecimals: number;
  reduceOnly: boolean;
  orderType: 'market' | 'limit';
}

interface HLCloseParams {
  assetIndex: number;
  coin: string;
  size: string;
  price: string;
  isBuy: boolean;
  szDecimals: number;
}

interface SwapTxRequest {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gas?: string;
  deadline: number;
  needsApproval?: boolean;
  approvalTransactions?: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    label: string;
  }[];
  approvalTransaction?: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    label: string;
  };
}

interface SwapAction {
  type: 'swap';
  tokenIn: string;
  tokenOut: string;
  amountInFormatted: string;
  amountOutFormatted: string;
  txRequest: SwapTxRequest;
}

interface BridgeAction {
  type: 'bridge';
  amountUsdc: number;
  fromChain: string;
  toChain: string;
  spokePoolAddress: string;
  depositData: {
    recipient: string;
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    outputAmount: string;
    destinationChainId: number;
    exclusiveRelayer: string;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityDeadline: number;
    message: string;
  };
}

interface TradeAction {
  type: 'open_trade';
  tradeParams: HLTradeParams;
  marketData?: {
    markPrice: string;
    fundingRate: string;
    maxLeverage: number;
  };
  sizeUsd?: number;
}

interface CloseAction {
  type: 'close_trade';
  closeParams: HLCloseParams;
}

type PendingAction = SwapAction | BridgeAction | TradeAction | CloseAction;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  action?: PendingAction;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PerpsChatInterface({ defaultCoin }: { defaultCoin?: string } = {}) {
  // Initialize messages as empty array (fixes hydration error)
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Wallet state — initialize as null to match server render
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);
  
  // Refs to lock wallet address during execution (prevents state updates from clearing it)
  const walletAddressRef = useRef<string | null>(null);
  const isExecutingRef = useRef(false);
  
  // Persist wallet address to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (walletAddress) {
        localStorage.setItem('perps_wallet_address', walletAddress);
      } else {
        localStorage.removeItem('perps_wallet_address');
      }
    } catch (err) {
      console.warn('[PerpsChat] Failed to save wallet address:', err);
    }
  }, [walletAddress]);

  // Mark as client-side after mount (prevents hydration mismatch)
  useEffect(() => {
    setIsClient(true);
    
    // Load wallet address from localStorage
    try {
      const saved = localStorage.getItem('perps_wallet_address');
      if (saved) {
        setWalletAddress(saved);
      }
    } catch (err) {
      console.warn('[PerpsChat] Failed to load saved wallet:', err);
    }
    
    // Load messages from localStorage
    try {
      const saved = localStorage.getItem('perps_chat_messages');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only restore if less than 24 hours old
        const maxAge = 24 * 60 * 60 * 1000;
        if (parsed.timestamp && Date.now() - parsed.timestamp < maxAge) {
          setMessages(parsed.messages || []);
        }
      }
    } catch (err) {
      console.warn('[PerpsChat] Failed to load chat history:', err);
    }
  }, []);

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(
        'perps_chat_messages',
        JSON.stringify({
          messages,
          timestamp: Date.now(),
        }),
      );
    } catch (err) {
      console.warn('[PerpsChat] Failed to save chat history:', err);
    }
  }, [messages]);

  // Hyperliquid account status
  const [hlStatus, setHlStatus] = useState<
    'checking' | 'funded' | 'spot_only' | 'unfunded' | null
  >(null);

  // Approved trading agent (programmatic keypair, signs orders without MetaMask)
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [agentApproving, setAgentApproving] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Load agent from localStorage whenever wallet changes
  useEffect(() => {
    if (!walletAddress) {
      setAgentInfo(null);
      return;
    }
    const stored = loadAgent(walletAddress);
    setAgentInfo(stored);
  }, [walletAddress]);

  const handleApproveAgent = useCallback(async () => {
    if (!walletAddress) return;
    setAgentApproving(true);
    setAgentError(null);
    try {
      const info = await approveAgentWithMetaMask(walletAddress);
      setAgentInfo(info);
      console.log('[HL Agent] Approved:', info.address);
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[HL Agent] Approval failed:', err);
      setAgentError(msg);
    } finally {
      setAgentApproving(false);
    }
  }, [walletAddress]);

  const handleResetAgent = useCallback(() => {
    clearAgent();
    setAgentInfo(null);
    setAgentError(null);
  }, []);
  const [hlBalance, setHlBalance] = useState<string | null>(null);
  const [hlSpotUsdc, setHlSpotUsdc] = useState<string | null>(null);

  // Trade execution state
  const [executing, setExecuting] = useState(false);
  
  // Review modal state (similar to Uniswap flow)
  const [reviewModal, setReviewModal] = useState<{
    tradeParams: HLTradeParams;
    marketData: {
      markPrice: string;
      fundingRate: string;
      maxLeverage: number;
    };
    sizeUsd: number;
  } | null>(null);

  // ─── Auto-scroll ──────────────────────────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ─── Check Hyperliquid account status ─────────────────────────────────

  const checkHLAccount = useCallback(async (address: string) => {
    setHlStatus('checking');
    setHlBalance(null);
    setHlSpotUsdc(null);

    const addr = address.toLowerCase();

    try {
      // Check BOTH perps clearinghouse and spot balances in parallel
      const [perpsRes, spotRes] = await Promise.all([
        fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: addr }),
        }),
        fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spotClearinghouseState',
            user: addr,
          }),
        }),
      ]);

      // Parse perps state — check every field Hyperliquid might return the
      // funded balance in. With Unified Account mode the value lives in
      // `withdrawable` or `totalRawUsd` rather than the cross-margin fields.
      let perpsValue = 0;
      if (perpsRes.ok) {
        const perps = await perpsRes.json();
        console.log('[HL] Raw perps response:', JSON.stringify({
          marginSummary: perps?.marginSummary,
          crossMarginSummary: perps?.crossMarginSummary,
          withdrawable: perps?.withdrawable,
        }));
        const candidates = [
          parseFloat(perps?.marginSummary?.accountValue || '0'),
          parseFloat(perps?.crossMarginSummary?.accountValue || '0'),
          parseFloat(perps?.withdrawable || '0'),
          parseFloat(perps?.marginSummary?.totalRawUsd || '0'),
          parseFloat(perps?.crossMarginSummary?.totalRawUsd || '0'),
        ];
        perpsValue = Math.max(...candidates);
        console.log('[HL] Perps value candidates:', candidates, '→ max:', perpsValue);
      }

      // Parse spot state — look for USDC balance
      let spotUsdcBalance = 0;
      let hasAnySpotBalance = false;
      if (spotRes.ok) {
        const spot = await spotRes.json();
        const balances: { coin: string; total: string }[] =
          spot?.balances || [];
        for (const b of balances) {
          if (parseFloat(b.total) > 0) hasAnySpotBalance = true;
          if (b.coin === 'USDC') {
            spotUsdcBalance = parseFloat(b.total);
          }
        }
      }

      console.log(
        `[HL] Account check: perps=$${perpsValue.toFixed(2)}, spotUSDC=$${spotUsdcBalance.toFixed(2)}, anySpot=${hasAnySpotBalance}`,
      );

      // On Hyperliquid with Unified Account mode enabled, spot USDC IS
      // the perps trading balance — there's no separate perps margin to fund.
      // So treat spot USDC as funded; if the account isn't actually unified,
      // the order will fail with a clearer insufficient-margin error.
      const effectiveTradingBalance = Math.max(perpsValue, spotUsdcBalance);

      if (effectiveTradingBalance > 0) {
        setHlStatus('funded');
        setHlBalance(`$${effectiveTradingBalance.toFixed(2)}`);
        if (spotUsdcBalance > 0) setHlSpotUsdc(`$${spotUsdcBalance.toFixed(2)}`);
      } else if (hasAnySpotBalance) {
        // Non-USDC spot balance only — can't trade perps, need to swap first
        setHlStatus('spot_only');
        setHlBalance(null);
      } else {
        setHlStatus('unfunded');
        setHlBalance(null);
      }
    } catch (err) {
      console.warn('[HL] Account check error:', err);
      setHlStatus('unfunded');
    }
  }, []);


  // ─── Detect MetaMask and auto-reconnect ──────────────────────────────────

  useEffect(() => {
    const checkWallet = async () => {
      if (typeof window === 'undefined' || !(window as any).ethereum) return;
      
      try {
        // If MetaMask is stuck on an unsupported chain (e.g. 1337 from old config),
        // switch to Arbitrum One so RPC calls work
        try {
          const curChain: string = await (window as any).ethereum.request({ method: 'eth_chainId' });
          const badChains = ['0x539']; // 1337 = Hyperliquid L1 (dead RPC)
          if (badChains.includes(curChain)) {
            console.warn('[PerpsChat] MetaMask on unsupported chain', curChain, '— switching to Arbitrum One');
            await (window as any).ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0xa4b1' }], // Arbitrum One (42161)
            }).catch(() => {
              // If Arbitrum not available, try Ethereum mainnet
              return (window as any).ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x1' }],
              });
            });
          }
        } catch { /* best effort — continue anyway */ }

        // First, check if we have a saved wallet address
        const savedAddress = walletAddress;
        
        // Check currently connected accounts
        const accounts: string[] = await (window as any).ethereum.request({
          method: 'eth_accounts',
        });
        
        if (accounts?.length > 0) {
          const addr = accounts[0];
          setWalletAddress(addr);
          walletAddressRef.current = addr;
          checkHLAccount(addr);
        } else if (savedAddress) {
          // We have a saved address but MetaMask disconnected
          // Try to reconnect automatically (silently, won't prompt)
          try {
            const reconnected: string[] = await (window as any).ethereum.request({
              method: 'eth_requestAccounts',
            });
            if (reconnected?.length > 0 && reconnected[0].toLowerCase() === savedAddress.toLowerCase()) {
              setWalletAddress(reconnected[0]);
              walletAddressRef.current = reconnected[0];
              checkHLAccount(reconnected[0]);
            } else {
              // Different account or still disconnected
              setWalletAddress(null);
              walletAddressRef.current = null;
            }
          } catch {
            // Reconnection failed, user will need to manually connect
            setWalletAddress(null);
            walletAddressRef.current = null;
          }
        }
      } catch (error) {
        console.warn('[PerpsChat] Wallet check error:', error);
      }
    };
    
    checkWallet();

    // Listen for account changes
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      const handleChange = (accounts: string[]) => {
        // Don't update state during active execution - preserve wallet address
        if (isExecutingRef.current) {
          console.log('[PerpsChat] Ignoring accountsChanged during execution');
          return;
        }
        
        // Only update if accounts actually changed (not just a re-check)
        const currentAddr = walletAddress?.toLowerCase();
        const newAddr = accounts[0]?.toLowerCase() || null;
        
        if (accounts.length === 0) {
          // User disconnected - clear state
          setWalletAddress(null);
          setHlStatus(null);
          setHlBalance(null);
          walletAddressRef.current = null;
        } else if (newAddr && newAddr !== currentAddr) {
          // Account actually changed - update
          setWalletAddress(accounts[0]);
          walletAddressRef.current = accounts[0];
          checkHLAccount(accounts[0]);
        }
        // If same account, don't update state unnecessarily (prevents disconnection during trades)
      };
      
      const handleConnect = (connectInfo: { chainId: string }) => {
        // MetaMask connected, check accounts
        checkWallet();
      };
      
      const handleDisconnect = (error: any) => {
        // Don't clear state during active execution - preserve wallet address
        if (isExecutingRef.current) {
          console.log('[PerpsChat] Ignoring disconnect event during execution');
          return;
        }
        
        // Only disconnect if MetaMask actually disconnected
        // Don't clear on temporary connection issues during signing
        if (typeof window !== 'undefined' && (window as any).ethereum) {
          // Check if MetaMask is still available
          (window as any).ethereum.request({ method: 'eth_accounts' })
            .then((accounts: string[]) => {
              if (accounts.length === 0) {
                // Actually disconnected
                setWalletAddress(null);
                setHlStatus(null);
                setHlBalance(null);
                walletAddressRef.current = null;
              }
            })
            .catch(() => {
              // MetaMask unavailable - clear state
              setWalletAddress(null);
              setHlStatus(null);
              setHlBalance(null);
              walletAddressRef.current = null;
            });
        } else {
          // MetaMask not available - clear state
          setWalletAddress(null);
          setHlStatus(null);
          setHlBalance(null);
          walletAddressRef.current = null;
        }
      };
      
      (window as any).ethereum.on('accountsChanged', handleChange);
      (window as any).ethereum.on('connect', handleConnect);
      (window as any).ethereum.on('disconnect', handleDisconnect);
      
      return () => {
        (window as any).ethereum?.removeListener?.('accountsChanged', handleChange);
        (window as any).ethereum?.removeListener?.('connect', handleConnect);
        (window as any).ethereum?.removeListener?.('disconnect', handleDisconnect);
      };
    }
  }, [checkHLAccount, walletAddress]);

  // ─── Message helpers ──────────────────────────────────────────────────

  const addMessage = useCallback(
    (
      role: Message['role'],
      content: string,
      action?: PendingAction,
    ): Message => {
      const msg: Message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role,
        content,
        timestamp: Date.now(),
        action,
      };
      setMessages((prev) => [...prev, msg]);
      return msg;
    },
    [],
  );

  // ─── Connect MetaMask ──────────────────────────────────────────────────

  const connectWallet = useCallback(async () => {
    if (typeof window === 'undefined' || !(window as any).ethereum) {
      addMessage('assistant', '❌ MetaMask not detected. Please install MetaMask to trade.');
      return;
    }

    try {
      // Escape dead chains (e.g. 1337 from old Hyperliquid L1 config)
      try {
        const curChain: string = await (window as any).ethereum.request({ method: 'eth_chainId' });
        if (curChain === '0x539') {
          await (window as any).ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0xa4b1' }], // Arbitrum One
          }).catch(() => (window as any).ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x1' }],
          }));
        }
      } catch { /* best effort */ }

      // Request connection (this will prompt user if not already connected)
      const accounts: string[] = await (window as any).ethereum.request({
        method: 'eth_requestAccounts',
      });
      
      if (accounts?.length > 0) {
        const addr = accounts[0];
        setWalletAddress(addr);
        walletAddressRef.current = addr;
        checkHLAccount(addr);
        addMessage('assistant', `✅ Connected: ${addr.slice(0, 6)}...${addr.slice(-4)}`);
      }
    } catch (error: any) {
      if (error?.code === 4001) {
        addMessage('assistant', '⚠️ Connection rejected. Please connect MetaMask to trade.');
      } else {
        console.error('[PerpsChat] Connection error:', error);
        addMessage('assistant', `❌ Connection failed: ${error?.message || 'Unknown error'}`);
      }
    }
  }, [checkHLAccount, addMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    addMessage('user', trimmed);
    setInput('');
    setLoading(true);

    try {
      const history = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: trimmed },
      ];

      const res = await fetch('/api/perps/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, walletAddress, defaultCoin }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const action = data.action as PendingAction | undefined;
      
      addMessage(
        'assistant',
        data.content || 'No response received.',
        action,
      );
      
      // If it's a trade action, show review modal instead of executing immediately
      if (action?.type === 'open_trade' && action.marketData && action.sizeUsd) {
        setReviewModal({
          tradeParams: action.tradeParams,
          marketData: action.marketData,
          sizeUsd: action.sizeUsd,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      addMessage('assistant', `❌ Error: ${msg}`);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  // ─── Create MetaMask-backed wallet for Hyperliquid SDK ────────────────
  //
  // Uses the AbstractEthersV6Signer interface:
  //   signTypedData(domain, types, value) — 3 args
  //   getAddress() — returns address
  //   provider — null
  //
  // Hyperliquid L1 actions sign against EIP-712 domain with chainId=1337.
  // Some wallets enforce that the domain chainId must match the active chain.
  // We handle this by:
  //   1. Try eth_signTypedData_v4 (standard)
  //   2. If chain mismatch → temporarily switch to Arbitrum and retry
  //   3. If still failing → try eth_signTypedData_v3 (less strict)
  // ──────────────────────────────────────────────────────────────────────

  const createHLWallet = useCallback(
    (address: string) => {
      const ethereum = (window as any).ethereum;

      return {
        // 3-argument signTypedData matches ethers v6 interface
        signTypedData: async function signTypedData(
          domain: { name?: string; version?: string; chainId?: number; verifyingContract?: string },
          types: Record<string, { name: string; type: string }[]>,
          value: Record<string, unknown>,
        ): Promise<string> {
          if (!ethereum) throw new Error('MetaMask not available');

          // Ensure wallet is on Arbitrum One — Hyperliquid signs with
          // chainId 42161 in the EIP-712 domain, and MetaMask/Phantom both
          // reject typed data when the wallet is on a different chain
          // (e.g. Base after a swap). Auto-switch (or add the network) here.
          try {
            const currentHex: string = await ethereum.request({ method: 'eth_chainId' });
            if (currentHex?.toLowerCase() !== '0xa4b1') {
              console.log('[HL Wallet] Switching to Arbitrum One before signing (was on', currentHex, ')');
              try {
                await ethereum.request({
                  method: 'wallet_switchEthereumChain',
                  params: [{ chainId: '0xa4b1' }],
                });
              } catch (switchErr: any) {
                if (switchErr?.code === 4902) {
                  await ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                      chainId: '0xa4b1',
                      chainName: 'Arbitrum One',
                      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                      rpcUrls: ['https://arb1.arbitrum.io/rpc'],
                      blockExplorerUrls: ['https://arbiscan.io'],
                    }],
                  });
                } else if (switchErr?.code === 4001 || switchErr?.code === 'ACTION_REJECTED') {
                  throw new Error('Please switch your wallet to Arbitrum One to trade perps.');
                } else {
                  throw switchErr;
                }
              }
            }
          } catch (chainErr) {
            console.warn('[HL Wallet] Chain check/switch failed, continuing anyway:', chainErr);
          }

          // Build EIP712Domain type from the domain object fields
          const domainType: { name: string; type: string }[] = [];
          if (domain.name !== undefined) domainType.push({ name: 'name', type: 'string' });
          if (domain.version !== undefined) domainType.push({ name: 'version', type: 'string' });
          if (domain.chainId !== undefined) domainType.push({ name: 'chainId', type: 'uint256' });
          if (domain.verifyingContract !== undefined) domainType.push({ name: 'verifyingContract', type: 'address' });

          // Primary type = first key in the types object
          const primaryType = Object.keys(types)[0];

          const payload = {
            domain,
            types: { EIP712Domain: domainType, ...types },
            primaryType,
            message: value,
          };

          // JSON.stringify with BigInt support
          const bigIntReplacer = (_key: string, v: unknown) =>
            typeof v === 'bigint' ? Number(v) : v;
          const jsonPayload = JSON.stringify(payload, bigIntReplacer);

          // Log what we're signing for debugging
          const isOrder = primaryType === 'Order' || primaryType === 'OrderWire' || primaryType === 'OrderRequest';
          const isAgent = primaryType === 'Agent';
          
          console.log('[HL Wallet] signTypedData:', {
            primaryType,
            isOrder: isOrder ? '✅ ORDER' : isAgent ? '⚠️ AGENT/CONNECTION' : '❓ OTHER',
            chainId: domain.chainId,
            domainName: domain.name,
            types: Object.keys(types),
            messageKeys: Object.keys(value),
            message: value,
          });
          
          // Warn if this looks like a connection signature when we expect an order
          if (isAgent) {
            console.warn('[HL Wallet] ⚠️ Signing Agent/Connection message (this is normal for leverage updates)');
          }

          // Helper: attempt signing with a given method
          const trySign = async (method: string): Promise<string> => {
            return ethereum.request({
              method,
              params: [address, jsonPayload],
            });
          };

          try {
            // Try eth_signTypedData_v4 — MetaMask signs with any chainId
            // in the EIP-712 domain without needing to be on that chain
            return await trySign('eth_signTypedData_v4');
          } catch (err: any) {
            // If user rejected, propagate immediately
            const code = err?.code ?? err?.data?.code;
            if (code === 4001 || String(err?.message || '').includes('rejected')) throw err;

            console.warn('[HL Wallet] eth_signTypedData_v4 failed, trying v3…', err?.message);
          }

          // Fallback: try eth_signTypedData_v3
          try {
            return await trySign('eth_signTypedData_v3');
          } catch (err3: any) {
            console.error('[HL Wallet] All signing methods failed:', err3);
            throw err3;
          }
        },

        getAddress: async function getAddress(): Promise<string> {
          return address;
        },

        provider: null,
      };
    },
    [],
  );

  // ─── Execute trade via Hyperliquid SDK ────────────────────────────────

  const handleOpenTrade = useCallback(
    async (action: TradeAction) => {
      if (!walletAddress || executing) return;
      
      // Lock wallet address and execution state
      walletAddressRef.current = walletAddress;
      isExecutingRef.current = true;
      setExecuting(true);
      
      // Verify wallet is still connected before proceeding
      if (typeof window !== 'undefined' && (window as any).ethereum) {
        try {
          const accounts = await (window as any).ethereum.request({ method: 'eth_accounts' });
          if (accounts.length === 0 || accounts[0].toLowerCase() !== walletAddress.toLowerCase()) {
            console.warn('[PerpsChat] Wallet disconnected during trade preparation');
            addMessage('assistant', '⚠️ Wallet disconnected. Please reconnect and try again.');
            isExecutingRef.current = false;
            setExecuting(false);
            return;
          }
          // Update ref with current address
          walletAddressRef.current = accounts[0];
        } catch (err) {
          console.error('[PerpsChat] Error verifying wallet connection:', err);
          addMessage('assistant', '⚠️ Could not verify wallet connection. Please reconnect and try again.');
          isExecutingRef.current = false;
          setExecuting(false);
          return;
        }
      }

      try {
        const p = action.tradeParams;
        addMessage(
          'assistant',
          `⚙️ Preparing ${p.side} ${p.coin} — ${p.leverage}x leverage…`,
        );

        // Dynamically import the SDK (browser-compatible)
        const { ExchangeClient, HttpTransport } = await import(
          '@nktkas/hyperliquid'
        );

        // Use ref value to ensure we have the locked wallet address
        const lockedAddress = walletAddressRef.current || walletAddress;
        if (!lockedAddress) {
          throw new Error('Wallet address lost during execution');
        }

        // ── Use the approved trading agent (no MetaMask popups for orders) ──
        const agent = loadAgent(lockedAddress);
        if (!agent) {
          addMessage(
            'assistant',
            `⚠️ No trading agent set up yet. Click "Set up trading agent" above (one-time MetaMask sig) and then try again.`,
          );
          isExecutingRef.current = false;
          setExecuting(false);
          return;
        }
        const { ethers } = await import('ethers');
        const agentSigner = new ethers.Wallet(agent.privateKey);
        const transport = new HttpTransport();
        let exchange = new ExchangeClient({
          transport,
          wallet: agentSigner as any,
          signatureChainId: '0xa4b1', // Arbitrum (42161) — Hyperliquid mainnet
        });

        // 1. Set leverage (this signs an "Agent" connection message)
        addMessage(
          'assistant',
          `📝 Setting ${p.leverage}x leverage — please **sign connection** in MetaMask…`,
        );
        console.log('[Hyperliquid] Updating leverage...');
        
        // Retry leverage update with exponential backoff
        let leverageUpdated = false;
        let leverageAttempts = 0;
        const maxLeverageAttempts = 3;
        
        while (!leverageUpdated && leverageAttempts < maxLeverageAttempts) {
          try {
            leverageAttempts++;
            
            // Re-verify wallet connection before each retry
            if (leverageAttempts > 1 && typeof window !== 'undefined' && (window as any).ethereum) {
              try {
                const accounts = await (window as any).ethereum.request({ method: 'eth_accounts' });
                if (accounts.length === 0 || accounts[0].toLowerCase() !== lockedAddress.toLowerCase()) {
                  console.warn('[Hyperliquid] Wallet disconnected during leverage update retry');
                  // Attempt to reconnect
                  const reconnected = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
                  if (reconnected.length > 0 && reconnected[0].toLowerCase() === lockedAddress.toLowerCase()) {
                    walletAddressRef.current = reconnected[0];
                    console.log('[Hyperliquid] Wallet reconnected, continuing...');
                  } else {
                    throw new Error('Wallet disconnected and could not reconnect');
                  }
                } else {
                  // Update ref to ensure we have latest address
                  walletAddressRef.current = accounts[0];
                }
              } catch (reconnectErr) {
                console.error('[Hyperliquid] Wallet reconnection failed:', reconnectErr);
                throw new Error('Wallet connection lost during leverage update');
              }
            }
            
            if (leverageAttempts > 1) {
              console.log(`[Hyperliquid] Leverage update attempt ${leverageAttempts}/${maxLeverageAttempts}...`);
              addMessage(
                'assistant',
                `🔄 Retrying leverage update (attempt ${leverageAttempts}/${maxLeverageAttempts})…`,
              );
              // Wait before retry (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 1000 * leverageAttempts));
            }
            
            await exchange.updateLeverage({
              asset: p.assetIndex,
              isCross: false,
              leverage: p.leverage,
            });
            leverageUpdated = true;
            console.log('[Hyperliquid] Leverage updated successfully');
          } catch (leverageError: any) {
            console.error(`[Hyperliquid] Leverage update attempt ${leverageAttempts} failed:`, leverageError);

            // Hyperliquid hardcodes chainId 1337 for Agent (leverage) messages,
            // but MetaMask refuses to sign typed data when domain chainId doesn't
            // match the active chain. There's no clean workaround without the
            // Approve Agent flow. Skip the leverage update and use whatever
            // leverage is currently set on the account — the order itself uses
            // chainId 42161 (Arbitrum) which signs fine.
            const errMsg = String(leverageError?.message || '') + ' ' + String(leverageError?.cause?.message || '');
            const isChainIdMismatch = errMsg.includes('chainId') && (errMsg.includes('1337') || errMsg.includes('must match'));
            if (isChainIdMismatch) {
              console.warn('[Hyperliquid] Leverage update blocked by MetaMask chainId check — skipping, will use account default leverage');
              addMessage(
                'assistant',
                `⚠️ Couldn't change leverage (MetaMask blocks Hyperliquid's chain-1337 signatures). Using your current account leverage instead.`,
              );
              leverageUpdated = true; // mark as "done" so we proceed to order placement
              break;
            }

            if (leverageAttempts >= maxLeverageAttempts) {
              throw new Error(`Failed to update leverage after ${maxLeverageAttempts} attempts: ${leverageError?.message || 'Unknown error'}`);
            }
            // Check if it's a user rejection - don't retry
            if (leverageError?.code === 4001 || leverageError?.code === 'ACTION_REJECTED') {
              throw leverageError;
            }
            // Check if it's a connection error - might be recoverable
            const errorMsg = leverageError?.message || '';
            if (errorMsg.includes('Wallet') || errorMsg.includes('connection') || errorMsg.includes('disconnected') || errorMsg.includes('MetaMask')) {
              // Will retry with reconnection check above
              console.log('[Hyperliquid] Connection error detected, will retry with reconnection');
              continue;
            }
          }
        }

        // Small delay to ensure leverage is fully processed
        await new Promise(resolve => setTimeout(resolve, 500));

        // 2. Place order (this signs an "Order" message)
        addMessage(
          'assistant',
          `📝 Placing ${p.side} order — please **sign order** in MetaMask…`,
        );
        console.log('[Hyperliquid] Placing order...');
        
        console.log('[Hyperliquid] Placing order:', {
          assetIndex: p.assetIndex,
          side: p.side,
          size: p.size,
          price: p.price,
          leverage: p.leverage,
          orderType: p.orderType,
        });

        // Retry order placement with exponential backoff
        let orderPlaced = false;
        let orderAttempts = 0;
        const maxOrderAttempts = 3;
        let result: any = null;
        
        while (!orderPlaced && orderAttempts < maxOrderAttempts) {
          try {
            orderAttempts++;
            
            // Re-verify wallet connection before each retry
            if (orderAttempts > 1 && typeof window !== 'undefined' && (window as any).ethereum) {
              try {
                const accounts = await (window as any).ethereum.request({ method: 'eth_accounts' });
                if (accounts.length === 0 || accounts[0].toLowerCase() !== lockedAddress.toLowerCase()) {
                  console.warn('[Hyperliquid] Wallet disconnected during order placement retry');
                  // Attempt to reconnect
                  const reconnected = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
                  if (reconnected.length > 0 && reconnected[0].toLowerCase() === lockedAddress.toLowerCase()) {
                    walletAddressRef.current = reconnected[0];
                    console.log('[Hyperliquid] Wallet reconnected — agent signer is independent of wallet, no exchange client rebuild needed');
                  } else {
                    throw new Error('Wallet disconnected and could not reconnect');
                  }
                } else {
                  // Update ref to ensure we have latest address
                  walletAddressRef.current = accounts[0];
                }
              } catch (reconnectErr) {
                console.error('[Hyperliquid] Wallet reconnection failed:', reconnectErr);
                throw new Error('Wallet connection lost during order placement');
              }
            }
            
            if (orderAttempts > 1) {
              console.log(`[Hyperliquid] Order placement attempt ${orderAttempts}/${maxOrderAttempts}...`);
              addMessage(
                'assistant',
                `🔄 Retrying order placement (attempt ${orderAttempts}/${maxOrderAttempts})…`,
              );
              // Wait before retry (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, 1000 * orderAttempts));
            }
            
            result = await exchange.order({
              orders: [
                {
                  a: p.assetIndex,
                  b: p.side === 'LONG',
                  p: p.price,
                  s: p.size,
                  r: p.reduceOnly,
                  t: {
                    limit: {
                      tif: p.orderType === 'market' ? 'Ioc' : 'Gtc',
                    },
                  },
                },
              ],
              grouping: 'na',
            });
            
            orderPlaced = true;
            console.log('[Hyperliquid] Order placed successfully');
          } catch (orderError: any) {
            console.error(`[Hyperliquid] Order placement attempt ${orderAttempts} failed:`, orderError);
            if (orderAttempts >= maxOrderAttempts) {
              throw new Error(`Failed to place order after ${maxOrderAttempts} attempts: ${orderError?.message || 'Unknown error'}`);
            }
            // Check if it's a user rejection - don't retry
            if (orderError?.code === 4001 || orderError?.code === 'ACTION_REJECTED') {
              throw orderError;
            }
            // Check if it's a validation error (e.g., tick size) - don't retry
            if (orderError?.message?.includes('tick size') || orderError?.message?.includes('Price must be divisible')) {
              throw orderError;
            }
            // Check if it's a connection error - might be recoverable
            const errorMsg = orderError?.message || '';
            if (errorMsg.includes('Wallet') || errorMsg.includes('connection') || errorMsg.includes('disconnected') || errorMsg.includes('MetaMask')) {
              // Will retry with reconnection check above
              console.log('[Hyperliquid] Connection error detected, will retry with reconnection');
              continue;
            }
          }
        }

        console.log('[Hyperliquid] Order result:', JSON.stringify(result, null, 2));

        // 3. Parse result - handle different response structures
        // The SDK might return: result.data.statuses or result.response.data.statuses
        const statuses = 
          result?.data?.statuses || 
          result?.response?.data?.statuses || 
          result?.statuses || 
          [];
        const status = statuses[0];

        if (!status) {
          console.error('[Hyperliquid] No status in result:', result);
          console.error('[Hyperliquid] Full result structure:', {
            hasData: !!result?.data,
            hasResponse: !!result?.response,
            hasStatuses: !!result?.statuses,
            keys: Object.keys(result || {}),
          });
          
          // Wait a bit and verify by checking open orders
          addMessage(
            'assistant',
            `⚠️ Order submission unclear. Verifying on Hyperliquid...`,
          );
          
          // Check multiple times with increasing delays
          const verifyOrder = async (attempt: number, maxAttempts: number = 3) => {
            try {
              const delay = 1000 * attempt; // 1s, 2s, 3s
              await new Promise(resolve => setTimeout(resolve, delay));
              
              const openOrdersRes = await fetch('https://api.hyperliquid.xyz/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'openOrders',
                  user: walletAddress.toLowerCase(),
                }),
              });
              const openOrders = await openOrdersRes.json();
              const orders = openOrders || [];
              
              // Try to find matching order (by coin and approximate size)
              const matchingOrder = orders.find(
                (o: any) => {
                  const sizeMatch = Math.abs(parseFloat(o.sz) - parseFloat(p.size)) < 0.01;
                  const coinMatch = o.coin === p.coin;
                  return coinMatch && sizeMatch;
                }
              );
              
              if (matchingOrder) {
                addMessage(
                  'assistant',
                  `✅ **Order confirmed on Hyperliquid!**\n\n` +
                    `• ${p.side} ${p.coin}\n` +
                    `• Size: ${matchingOrder.sz} ${p.coin}\n` +
                    `• Order ID: ${matchingOrder.oid || 'N/A'}\n` +
                    `• Status: ${matchingOrder.status || 'active'}`,
                );
                return true;
              } else if (attempt < maxAttempts) {
                // Retry verification
                return await verifyOrder(attempt + 1, maxAttempts);
              } else {
                // Final attempt failed
                addMessage(
                  'assistant',
                  `❌ Order not found after ${maxAttempts} verification attempts. The order may have been rejected, filled immediately, or failed. Please check your Hyperliquid account.`,
                );
                return false;
              }
            } catch (verifyErr) {
              console.error(`[Hyperliquid] Verification attempt ${attempt} error:`, verifyErr);
              if (attempt < maxAttempts) {
                return await verifyOrder(attempt + 1, maxAttempts);
              } else {
                addMessage(
                  'assistant',
                  `⚠️ Could not verify order status after ${maxAttempts} attempts. Please check your Hyperliquid account manually.`,
                );
                return false;
              }
            }
          };
          
          await verifyOrder(1);
          return;
        }

        if (status?.filled) {
          // Calculate notional value for display
          const notional = parseFloat(p.size) * parseFloat(status.filled.avgPx || p.price);
          addMessage(
            'assistant',
            `✅ **Trade filled!**\n\n` +
              `• ${p.side} ${p.coin}\n` +
              `• Size: ${p.size} ${p.coin} ($${notional.toFixed(2)} notional)\n` +
              `• Leverage: ${p.leverage}x\n` +
              `• Filled at: $${status.filled.avgPx || 'market'}\n` +
              `• Order ID: ${status.filled.oid || 'N/A'}`,
          );
        } else if (status?.resting) {
          // Calculate notional value for display
          const notional = parseFloat(p.size) * parseFloat(p.price);
          addMessage(
            'assistant',
            `📋 **Order placed (resting)**\n\n` +
              `• ${p.side} ${p.coin}\n` +
              `• Size: ${p.size} ${p.coin} ($${notional.toFixed(2)} notional)\n` +
              `• Limit: $${p.price}\n` +
              `• Order ID: ${status.resting.oid || 'N/A'}`,
          );
        } else if (status?.error) {
          const errorMsg = typeof status.error === 'string' 
            ? status.error 
            : JSON.stringify(status.error);
          addMessage('assistant', `❌ Order rejected: ${errorMsg}`);
        } else {
          // Unknown status - log and verify
          console.warn('[Hyperliquid] Unknown status:', status);
          addMessage(
            'assistant',
            `⚠️ Order submitted with unknown status. Verifying...`,
          );
          
          // Verify by checking open orders
          setTimeout(async () => {
            try {
              const openOrdersRes = await fetch('https://api.hyperliquid.xyz/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'openOrders',
                  user: walletAddress.toLowerCase(),
                }),
              });
              const openOrders = await openOrdersRes.json();
              const orders = openOrders || [];
              const matchingOrder = orders.find(
                (o: any) => 
                  o.coin === p.coin && 
                  Math.abs(parseFloat(o.sz) - parseFloat(p.size)) < 0.01
              );
              
              if (matchingOrder) {
                addMessage(
                  'assistant',
                  `✅ **Order confirmed on Hyperliquid!**\n\n` +
                    `• ${p.side} ${p.coin}\n` +
                    `• Size: ${matchingOrder.sz} ${p.coin}\n` +
                    `• Order ID: ${matchingOrder.oid || 'N/A'}`,
                );
              } else {
                addMessage(
                  'assistant',
                  `❌ Order not found. Status: ${JSON.stringify(status)}`,
                );
              }
            } catch (verifyErr) {
              console.error('[Hyperliquid] Verification error:', verifyErr);
            }
          }, 2000);
        }
      } catch (error: any) {
        const cause = error?.cause;
        const isUserRejection =
          error?.code === 4001 ||
          error?.code === 'ACTION_REJECTED' ||
          cause?.code === 4001 ||
          cause?.code === 'ACTION_REJECTED';

        const errorMsg = error?.message || 'Unknown error';
        const isConnectionError = 
          errorMsg.includes('Wallet') || 
          errorMsg.includes('connection') || 
          errorMsg.includes('disconnected') ||
          errorMsg.includes('MetaMask not available');
        
        if (isUserRejection) {
          addMessage('assistant', '⚠️ Trade was rejected in MetaMask.');
        } else if (isConnectionError) {
          addMessage(
            'assistant',
            `⚠️ Wallet connection issue: ${errorMsg}. Please ensure MetaMask is connected and try again.`,
          );
        } else {
          console.error('[Hyperliquid] Trade error:', error);
          if (cause) console.error('[Hyperliquid] Cause:', cause);
          const detail = cause?.message || errorMsg;
          addMessage(
            'assistant',
            `❌ Trade failed: ${detail}`,
          );
        }
      } finally {
        // Always release execution lock
        isExecutingRef.current = false;
        setExecuting(false);
      }
    },
    [walletAddress, executing, addMessage, createHLWallet],
  );

  // ─── Confirm and execute trade (called from review modal) ──────────────

  const handleConfirmTrade = useCallback(async () => {
    if (!reviewModal || !walletAddress || executing) return;
    setExecuting(true);
    const modalData = { ...reviewModal };
    setReviewModal(null); // Close modal

    try {
      const action: TradeAction = {
        type: 'open_trade',
        tradeParams: modalData.tradeParams,
        marketData: modalData.marketData,
        sizeUsd: modalData.sizeUsd,
      };
      await handleOpenTrade(action);
    } catch (error) {
      console.error('[PerpsChat] Trade execution error:', error);
    } finally {
      setExecuting(false);
    }
  }, [reviewModal, walletAddress, executing, handleOpenTrade]);

  // ─── Close position via Hyperliquid SDK ───────────────────────────────

  const handleClosePosition = useCallback(
    async (action: CloseAction) => {
      if (!walletAddress || executing) return;
      setExecuting(true);

      try {
        const p = action.closeParams;
        addMessage('assistant', `🔒 Closing ${p.coin} position…`);

        const { ExchangeClient, HttpTransport } = await import(
          '@nktkas/hyperliquid'
        );

        const agent = loadAgent(walletAddress);
        if (!agent) {
          addMessage(
            'assistant',
            `⚠️ No trading agent set up. Click "Set up trading agent" above and try again.`,
          );
          return;
        }
        const { ethers } = await import('ethers');
        const agentSigner = new ethers.Wallet(agent.privateKey);
        const transport = new HttpTransport();
        const exchange = new ExchangeClient({
          transport,
          wallet: agentSigner as any,
          signatureChainId: '0xa4b1',
        });

        addMessage(
          'assistant',
          `📝 Please **sign the close order** in MetaMask…`,
        );

        const result: any = await exchange.order({
          orders: [
            {
              a: p.assetIndex,
              b: p.isBuy,
              p: p.price,
              s: p.size,
              r: true, // reduce only
              t: { limit: { tif: 'Ioc' } },
            },
          ],
          grouping: 'na',
        });

        const statuses = result?.response?.data?.statuses || [];
        const status = statuses[0];

        if (status?.filled) {
          addMessage(
            'assistant',
            `✅ **Position closed!**\n\n` +
              `• ${p.coin}: ${p.size} closed\n` +
              `• Filled at: $${status.filled.avgPx || 'market'}`,
          );
        } else if (status?.error) {
          addMessage('assistant', `❌ Close rejected: ${status.error}`);
        } else {
          addMessage(
            'assistant',
            `✅ Close order submitted! Response: ${JSON.stringify(result).slice(0, 200)}`,
          );
        }
      } catch (error: any) {
        const cause = error?.cause;
        const isUserRejection =
          error?.code === 4001 ||
          error?.code === 'ACTION_REJECTED' ||
          cause?.code === 4001 ||
          cause?.code === 'ACTION_REJECTED';

        if (isUserRejection) {
          addMessage(
            'assistant',
            '⚠️ Close position was rejected in MetaMask.',
          );
        } else {
          console.error('[Hyperliquid] Close error:', error);
          if (cause) console.error('[Hyperliquid] Cause:', cause);
          const detail = cause?.message || error?.message || 'Unknown error';
          addMessage(
            'assistant',
            `❌ Close error: ${detail}`,
          );
        }
      } finally {
        setExecuting(false);
      }
    },
    [walletAddress, executing, addMessage, createHLWallet],
  );

  // ─── Execute swap via MetaMask ───────────────────────────────────────

  const handleSwap = useCallback(
    async (action: SwapAction) => {
      if (!walletAddress || executing) return;
      setExecuting(true);

      try {
        const ethereum = (window as any).ethereum;
        if (!ethereum) throw new Error('MetaMask not found');

        const tx = action.txRequest;

        // Ensure we're on Base
        const chainIdHex = `0x${(8453).toString(16)}`;
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex }],
          });
        } catch (switchErr: any) {
          if (switchErr.code === 4902) {
            await ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: chainIdHex,
                  chainName: 'Base',
                  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                  rpcUrls: ['https://mainnet.base.org'],
                  blockExplorerUrls: ['https://basescan.org'],
                },
              ],
            });
          } else {
            throw switchErr;
          }
        }

        // Handle approvals if needed
        const approvals = tx.approvalTransactions || (tx.approvalTransaction ? [tx.approvalTransaction] : []);
        for (const approval of approvals) {
          addMessage(
            'assistant',
            `📝 ${approval.label} — please **approve** in MetaMask…`,
          );
          await ethereum.request({
            method: 'eth_sendTransaction',
            params: [
              {
                from: walletAddress,
                to: approval.to,
                data: approval.data,
                value: approval.value || '0x0',
              },
            ],
          });
          // Brief wait for the approval to be mined
          await new Promise((r) => setTimeout(r, 3000));
        }

        // Send the swap transaction
        addMessage(
          'assistant',
          `🔄 Swapping ${action.amountInFormatted} ${action.tokenIn} → ${action.amountOutFormatted} ${action.tokenOut} — **sign** in MetaMask…`,
        );

        const txHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: walletAddress,
              to: tx.to,
              data: tx.data,
              value: tx.value || '0x0',
              ...(tx.gas ? { gas: `0x${parseInt(tx.gas).toString(16)}` } : {}),
            },
          ],
        });

        addMessage(
          'assistant',
          `✅ **Swap submitted!**\n\n` +
            `• ${action.amountInFormatted} ${action.tokenIn} → ${action.amountOutFormatted} ${action.tokenOut}\n` +
            `• Tx: [${(txHash as string).slice(0, 10)}…](https://basescan.org/tx/${txHash})`,
        );
      } catch (error: any) {
        if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') {
          addMessage('assistant', '⚠️ Swap was rejected in MetaMask.');
        } else {
          console.error('[Swap] Error:', error);
          addMessage(
            'assistant',
            `❌ Swap error: ${error?.message || 'Unknown error'}`,
          );
        }
      } finally {
        setExecuting(false);
      }
    },
    [walletAddress, executing, addMessage],
  );

  // ─── Execute bridge via MetaMask (Across Protocol) ────────────────────

  const handleBridge = useCallback(
    async (action: BridgeAction) => {
      if (!walletAddress || executing) return;
      setExecuting(true);

      try {
        const ethereum = (window as any).ethereum;
        if (!ethereum) throw new Error('MetaMask not found');

        // Ensure we're on Base
        const chainIdHex = `0x${(8453).toString(16)}`;
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex }],
          });
        } catch (switchErr: any) {
          if (switchErr.code === 4902) {
            await ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: chainIdHex,
                  chainName: 'Base',
                  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                  rpcUrls: ['https://mainnet.base.org'],
                  blockExplorerUrls: ['https://basescan.org'],
                },
              ],
            });
          } else {
            throw switchErr;
          }
        }

        const d = action.depositData;
        const USDC_ADDRESS = d.inputToken;
        const SPOKE_POOL = action.spokePoolAddress;

        // 1. Approve USDC for SpokePool
        addMessage(
          'assistant',
          `📝 Approving $${action.amountUsdc} USDC for the Across bridge — **approve** in MetaMask…`,
        );

        // ERC20 approve(spender, amount)
        const approveData =
          '0x095ea7b3' +
          SPOKE_POOL.slice(2).padStart(64, '0') +
          BigInt(d.inputAmount).toString(16).padStart(64, '0');

        await ethereum.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: walletAddress,
              to: USDC_ADDRESS,
              data: approveData,
              value: '0x0',
            },
          ],
        });

        // Wait for approval to be mined
        addMessage('assistant', '⏳ Waiting for approval to confirm…');
        await new Promise((r) => setTimeout(r, 5000));

        // 2. Call depositV3 on Across SpokePool
        addMessage(
          'assistant',
          `🌉 Bridging $${action.amountUsdc} USDC from Base → Arbitrum — **sign** in MetaMask…`,
        );

        // Encode depositV3(address depositor, address recipient, address inputToken, address outputToken,
        //   uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer,
        //   uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message)
        const depositSelector = '0xe7a7ed02'; // depositV3 selector

        // For a proper ABI encoding, we'll use a simpler approach — construct raw calldata
        const pad = (hex: string) => hex.replace('0x', '').padStart(64, '0');
        const padNum = (n: number | string) =>
          BigInt(n).toString(16).padStart(64, '0');

        const depositCalldata =
          depositSelector +
          pad(walletAddress) + // depositor
          pad(d.recipient) + // recipient
          pad(d.inputToken) + // inputToken
          pad(d.outputToken) + // outputToken
          padNum(d.inputAmount) + // inputAmount
          padNum(d.outputAmount) + // outputAmount
          padNum(d.destinationChainId) + // destinationChainId
          pad(d.exclusiveRelayer) + // exclusiveRelayer
          padNum(d.quoteTimestamp) + // quoteTimestamp
          padNum(d.fillDeadline) + // fillDeadline
          padNum(d.exclusivityDeadline) + // exclusivityDeadline
          // bytes offset + length + data for message "0x"
          padNum(12 * 32) + // offset to bytes (12 params * 32)
          padNum(0); // empty bytes length

        const bridgeTxHash = await ethereum.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: walletAddress,
              to: SPOKE_POOL,
              data: depositCalldata,
              value: '0x0',
            },
          ],
        });

        addMessage(
          'assistant',
          `✅ **Bridge submitted!**\n\n` +
            `• $${action.amountUsdc} USDC: Base → Arbitrum\n` +
            `• Estimated arrival: 2-5 minutes\n` +
            `• Tx: [${(bridgeTxHash as string).slice(0, 10)}…](https://basescan.org/tx/${bridgeTxHash})\n\n` +
            `After the bridge completes, deposit your USDC from Arbitrum to Hyperliquid at:\n` +
            `**https://app.hyperliquid.xyz/portfolio**`,
        );

        // Re-check HL account after a delay (bridge takes a few minutes, but user may already have funds)
        setTimeout(() => {
          if (walletAddress) checkHLAccount(walletAddress);
        }, 10_000);
      } catch (error: any) {
        if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') {
          addMessage('assistant', '⚠️ Bridge was rejected in MetaMask.');
        } else {
          console.error('[Bridge] Error:', error);
          addMessage(
            'assistant',
            `❌ Bridge error: ${error?.message || 'Unknown error'}`,
          );
        }
      } finally {
        setExecuting(false);
      }
    },
    [walletAddress, executing, addMessage],
  );

  const handleQuickAction = (prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  // ─── Format message content ───────────────────────────────────────────

  const formatContent = (content: string) => {
    return content.split('\n').map((line, i) => {
      const parts = line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={j} className="text-trading-text font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return part;
      });

      if (line.trim() === '') return <br key={i} />;

      if (line.trim().startsWith('•') || line.trim().startsWith('-')) {
        return (
          <div key={i} className="flex gap-2 ml-2">
            <span className="text-white/50 flex-shrink-0">•</span>
            <span>{parts}</span>
          </div>
        );
      }

      return <div key={i}>{parts}</div>;
    });
  };

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* ─── Wallet + Hyperliquid status banner ──────────────────────── */}
      {!walletAddress && (
        <div className="px-3 py-2 mb-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <div className="flex items-center justify-between">
            <span className="text-xs text-yellow-400">
              ⚠️ Connect MetaMask to trade on Hyperliquid
            </span>
            <button
              onClick={connectWallet}
              className="px-3 py-1 text-xs font-medium bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 rounded-lg transition-colors"
            >
              Connect
            </button>
          </div>
        </div>
      )}
      {walletAddress && hlStatus === 'checking' && (
        <div className="px-3 py-2 mb-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-blue-400/40 border-t-blue-400 rounded-full animate-spin" />
            <span className="text-xs text-blue-400">
              Checking Hyperliquid account…
            </span>
          </div>
        </div>
      )}
      {walletAddress && hlStatus === 'funded' && (
        <div className="px-3 py-2 mb-3 rounded-xl bg-green-500/10 border border-green-500/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-green-400">
                Hyperliquid · {walletAddress.slice(0, 6)}…
                {walletAddress.slice(-4)}
              </span>
            </div>
            {hlBalance && (
              <span className="text-xs text-green-400 font-medium">
                {hlBalance}
              </span>
            )}
          </div>
        </div>
      )}
      {/* ── Trading agent setup banner (shown when wallet+HL ready but no agent) ── */}
      {walletAddress && hlStatus === 'funded' && !agentInfo && (
        <div className="relative overflow-hidden mb-3 rounded-2xl p-[1.5px] bg-gradient-to-br from-[#a855f7] via-[#ec4899] to-[#f59e0b]">
          <div className="rounded-[15px] bg-[#0a0a0f]/95 backdrop-blur-xl p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#a855f7]/20 to-[#ec4899]/20 border border-white/10 flex items-center justify-center flex-shrink-0">
                <span className="text-base">🔑</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-white">Set up trading agent</p>
                <p className="text-xs text-white/60 mt-0.5">
                  One MetaMask sig authorizes a programmatic agent. After that, every trade is one-click — no popups, no chain switches.
                </p>
              </div>
            </div>
            {agentError && (
              <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {agentError}
              </div>
            )}
            <button
              onClick={handleApproveAgent}
              disabled={agentApproving}
              className="relative w-full rounded-xl py-3 text-sm font-bold text-white overflow-hidden disabled:opacity-60 disabled:cursor-not-allowed group"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-[#a855f7] via-[#ec4899] to-[#f59e0b] group-hover:brightness-110 transition-all" />
              <span className="relative">
                {agentApproving ? 'Waiting for MetaMask…' : 'Authorize agent (1 sig)'}
              </span>
            </button>
          </div>
        </div>
      )}
      {/* ── Active agent indicator + revoke ── */}
      {walletAddress && hlStatus === 'funded' && agentInfo && (
        <div className="px-3 py-2 mb-3 rounded-xl bg-white/[0.03] border border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
            <span className="text-[11px] text-white/70">
              Agent active · <span className="font-mono">{agentInfo.address.slice(0, 6)}…{agentInfo.address.slice(-4)}</span>
            </span>
          </div>
          <button
            onClick={handleResetAgent}
            className="text-[10px] text-white/40 hover:text-white/80 underline"
          >
            reset
          </button>
        </div>
      )}
      {walletAddress && hlStatus === 'spot_only' && (
        <div className="px-3 py-2.5 mb-3 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs">🟡</span>
              <span className="text-xs text-amber-400 font-medium">
                Hyperliquid account found — perps not funded
              </span>
            </div>
            {hlSpotUsdc && (
              <span className="text-xs text-amber-400 font-medium">
                Spot: {hlSpotUsdc}
              </span>
            )}
          </div>
          <p className="text-[10px] text-amber-400/70 leading-relaxed ml-5">
            Transfer USDC from your spot wallet to perps margin at{' '}
            <a
              href="https://app.hyperliquid.xyz/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-amber-300"
            >
              app.hyperliquid.xyz
            </a>{' '}
            to enable trading.
          </p>
          <button
            onClick={() => checkHLAccount(walletAddress)}
            className="ml-5 text-[10px] text-amber-400/80 hover:text-amber-300 underline"
          >
            Re-check
          </button>
        </div>
      )}
      {walletAddress && hlStatus === 'unfunded' && (
        <div className="px-3 py-2.5 mb-3 rounded-xl bg-red-500/10 border border-red-500/20 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs">🔴</span>
            <span className="text-xs text-red-400 font-medium">
              No Hyperliquid account found
            </span>
          </div>
          <p className="text-[10px] text-red-400/70 leading-relaxed ml-5">
            You need USDC deposited on Hyperliquid to trade. Use the chat to
            swap &amp; bridge, or deposit at{' '}
            <a
              href="https://app.hyperliquid.xyz/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-red-300"
            >
              app.hyperliquid.xyz
            </a>
          </p>
          <button
            onClick={() => checkHLAccount(walletAddress)}
            className="ml-5 text-[10px] text-red-400/80 hover:text-red-300 underline"
          >
            Re-check account
          </button>
        </div>
      )}

      {/* ─── Messages ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-5 px-1 pb-4">
        {messages.length === 0 && isClient && (
          <div className="flex flex-col items-center justify-center h-full text-center py-10">
            <h3 className="text-[15px] font-semibold text-white/90 mb-1.5">
              How can I help you trade?
            </h3>
            <p className="text-[12px] text-white/40 max-w-md mb-6 leading-relaxed">
              {!walletAddress
                ? 'Connect MetaMask to start trading. Ask about markets without a wallet.'
                : hlStatus === 'funded'
                  ? 'Ask about any market or place a trade. 150+ perps, up to 50x leverage.'
                  : hlStatus === 'spot_only'
                    ? 'Transfer USDC from spot to perps margin to enable trading.'
                    : hlStatus === 'unfunded'
                      ? 'Swap & bridge USDC to fund your Hyperliquid account.'
                      : 'Checking your Hyperliquid account…'}
            </p>

            {/* Quick actions */}
            <div className="grid grid-cols-1 gap-1.5 max-w-md w-full">
              {[
                {
                  label: 'Analyze the ETH perpetual market',
                  prompt: 'Analyze the ETH perpetual market on Hyperliquid.',
                },
                {
                  label: "What's happening with BTC?",
                  prompt: "What's happening with BTC? Show me the market data.",
                },
                {
                  label: 'Swap $50 ETH → USDC on Base',
                  prompt: 'Swap $50 of ETH to USDC on Base via Uniswap.',
                },
                {
                  label: 'Fund Hyperliquid with $100 from Base',
                  prompt:
                    'I want to fund my Hyperliquid account with $100 USDC from Base. Walk me through the steps.',
                },
              ].map((a) => (
                <button
                  key={a.label}
                  onClick={() => handleQuickAction(a.prompt)}
                  className="text-left text-[12px] bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.06] hover:border-white/10 rounded-lg px-3 py-2 text-white/70 hover:text-white/90 transition-all duration-150"
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={
                message.role === 'user'
                  ? 'max-w-[85%] rounded-2xl px-3.5 py-2 bg-white/[0.06] text-white/95'
                  : 'w-full text-white/85'
              }
            >
              {message.role === 'assistant' ? (
                <div className="text-[13.5px] leading-relaxed space-y-1">
                  {formatContent(message.content)}
                </div>
              ) : (
                <p className="text-[13.5px] whitespace-pre-wrap leading-relaxed">
                  {message.content}
                </p>
              )}

              {/* Open Trade button */}
              {message.action?.type === 'open_trade' && (
                <>
                  <button
                    onClick={() => {
                      const action = message.action as TradeAction;
                      if (action.marketData && action.sizeUsd) {
                        setReviewModal({
                          tradeParams: action.tradeParams,
                          marketData: action.marketData,
                          sizeUsd: action.sizeUsd,
                        });
                      } else {
                        // Fallback to direct execution if modal data not available
                        handleOpenTrade(action);
                      }
                    }}
                    disabled={executing || hlStatus !== 'funded'}
                    className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background:
                        executing || hlStatus !== 'funded'
                          ? 'linear-gradient(135deg, #6B7280, #4B5563)'
                          : (message.action as TradeAction).tradeParams
                                .side === 'LONG'
                            ? 'linear-gradient(135deg, #10B981, #059669)'
                            : 'linear-gradient(135deg, #EF4444, #DC2626)',
                    }}
                  >
                    {executing ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Executing…
                      </>
                    ) : (
                      <>
                        {(message.action as TradeAction).tradeParams.side ===
                        'LONG'
                          ? '📈'
                          : '📉'}{' '}
                        {(message.action as TradeAction).tradeParams.side}{' '}
                        {(message.action as TradeAction).tradeParams.coin} —{' '}
                        {(message.action as TradeAction).tradeParams.size} @{' '}
                        {
                          (message.action as TradeAction).tradeParams.leverage
                        }
                        x
                      </>
                    )}
                  </button>
                  {hlStatus === 'spot_only' && (
                    <p className="text-[10px] text-amber-400/80 mt-1 text-center">
                      ⚠️ Transfer USDC from spot → perps margin on Hyperliquid
                    </p>
                  )}
                  {hlStatus !== 'funded' && hlStatus !== 'spot_only' && (
                    <p className="text-[10px] text-red-400/80 mt-1 text-center">
                      ⚠️ Fund your Hyperliquid account to enable trading
                    </p>
                  )}
                </>
              )}

              {/* Close Position button */}
              {message.action?.type === 'close_trade' && (
                <>
                  <button
                    onClick={() =>
                      handleClosePosition(message.action as CloseAction)
                    }
                    disabled={executing || hlStatus !== 'funded'}
                    className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background:
                        executing || hlStatus !== 'funded'
                          ? 'linear-gradient(135deg, #6B7280, #4B5563)'
                          : 'linear-gradient(135deg, #F59E0B, #D97706)',
                    }}
                  >
                    {executing ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Closing…
                      </>
                    ) : (
                      <>
                        🔒 Close{' '}
                        {(message.action as CloseAction).closeParams.coin} —{' '}
                        {(message.action as CloseAction).closeParams.size}
                      </>
                    )}
                  </button>
                  {hlStatus === 'spot_only' && (
                    <p className="text-[10px] text-amber-400/80 mt-1 text-center">
                      ⚠️ Transfer USDC from spot → perps margin on Hyperliquid
                    </p>
                  )}
                  {hlStatus !== 'funded' && hlStatus !== 'spot_only' && (
                    <p className="text-[10px] text-red-400/80 mt-1 text-center">
                      ⚠️ Fund your Hyperliquid account to enable trading
                    </p>
                  )}
                </>
              )}

              {/* Swap button */}
              {message.action?.type === 'swap' && (
                <button
                  onClick={() => handleSwap(message.action as SwapAction)}
                  disabled={executing}
                  className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: executing
                      ? 'linear-gradient(135deg, #6B7280, #4B5563)'
                      : 'linear-gradient(135deg, #6366F1, #4F46E5)',
                  }}
                >
                  {executing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Swapping…
                    </>
                  ) : (
                    <>
                      🔄 Swap{' '}
                      {(message.action as SwapAction).amountInFormatted}{' '}
                      {(message.action as SwapAction).tokenIn} →{' '}
                      {(message.action as SwapAction).amountOutFormatted}{' '}
                      {(message.action as SwapAction).tokenOut}
                    </>
                  )}
                </button>
              )}

              {/* Bridge button */}
              {message.action?.type === 'bridge' && (
                <button
                  onClick={() => handleBridge(message.action as BridgeAction)}
                  disabled={executing}
                  className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: executing
                      ? 'linear-gradient(135deg, #6B7280, #4B5563)'
                      : 'linear-gradient(135deg, #10B981, #059669)',
                  }}
                >
                  {executing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Bridging…
                    </>
                  ) : (
                    <>
                      🌉 Bridge ${(message.action as BridgeAction).amountUsdc}{' '}
                      USDC → Arbitrum
                    </>
                  )}
                </button>
              )}

            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 py-1">
              <span
                className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce"
                style={{ animationDelay: '0ms' }}
              />
              <span
                className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce"
                style={{ animationDelay: '150ms' }}
              />
              <span
                className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce"
                style={{ animationDelay: '300ms' }}
              />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ─── Input ─────────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        className="mt-3 flex items-center gap-2 rounded-2xl bg-white/[0.04] border border-white/[0.08] focus-within:border-white/20 focus-within:bg-white/[0.06] transition-colors px-3 py-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message AI Analyst…"
          className="flex-1 bg-transparent text-[13.5px] text-white placeholder:text-white/30 focus:outline-none"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center justify-center w-7 h-7 rounded-full bg-white text-black disabled:bg-white/20 disabled:text-white/40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {loading ? (
            <div className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </button>
      </form>

      {/* Review Modal */}
      {reviewModal && walletAddress && (
        <PerpsReviewModal
          tradeParams={reviewModal.tradeParams}
          marketData={reviewModal.marketData}
          sizeUsd={reviewModal.sizeUsd}
          walletAddress={walletAddress}
          onConfirm={handleConfirmTrade}
          onCancel={() => setReviewModal(null)}
          loading={executing}
        />
      )}
    </div>
  );
}
