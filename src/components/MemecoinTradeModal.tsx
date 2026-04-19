'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { VersionedTransaction } from '@solana/web3.js';
import { saveHolding } from './MemecoinHoldings';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MemecoinTradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol: string;
  tokenPrice: number;
  logoURI?: string;
  walletAddress?: string;
  onConnectWallet?: () => Promise<string | null>;
  defaultSellAmount?: number;
  onSellSuccess?: () => void;
}

type TxState = 'idle' | 'quoting' | 'confirming' | 'signing' | 'sending' | 'success' | 'error';

const SOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOL_LAMPORTS = 1_000_000_000;
const BUY_PRESETS  = ['0.1', '0.5', '1', '2'];
const SELL_PRESETS = ['25%', '50%', '75%', '100%'];

// ─── Small helpers ────────────────────────────────────────────────────────────

function TokenAvatar({ logoURI, symbol, size = 44 }: { logoURI?: string; symbol: string; size?: number }) {
  const [err, setErr] = useState(false);
  const colors = ['#f97316','#a855f7','#3b82f6','#22c55e','#ec4899','#eab308','#06b6d4','#ef4444'];
  const bg = colors[symbol.charCodeAt(0) % colors.length];

  if (logoURI && !err) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoURI} alt={symbol} width={size} height={size}
        className="rounded-full object-cover ring-2 ring-white/10"
        style={{ width: size, height: size }}
        onError={() => setErr(true)} />
    );
  }
  return (
    <div className="rounded-full flex items-center justify-center font-bold text-white ring-2 ring-white/10"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.38 }}>
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

function Spinner({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" className="animate-spin">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MemecoinTradeModal({
  isOpen,
  onClose,
  mode: initialMode,
  tokenAddress,
  tokenSymbol,
  tokenPrice,
  logoURI,
  walletAddress,
  defaultSellAmount,
  onSellSuccess,
}: MemecoinTradeModalProps) {
  const [mode, setMode]         = useState<'buy' | 'sell'>(initialMode);
  const [amount, setAmount]     = useState('');
  const [txState, setTxState]   = useState<TxState>('idle');
  const [txSig, setTxSig]       = useState('');
  const [errMsg, setErrMsg]     = useState('');
  const [hasPhantom, setHasPhantom] = useState<boolean | null>(null);
  const [boughtAmount, setBoughtAmount] = useState<number>(0);
  const [mounted, setMounted] = useState(false);
  // Real on-chain balance — fetched when sell modal opens
  const [realBalance, setRealBalance] = useState<number | null>(null);
  const [realDecimals, setRealDecimals] = useState<number>(6);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => { setMode(initialMode); }, [initialMode]);

  useEffect(() => {
    if (!isOpen) return;
    setHasPhantom(typeof window !== 'undefined' && !!(window as any).solana?.isPhantom);
  }, [isOpen]);

  // Fetch real on-chain balance whenever sell modal opens
  useEffect(() => {
    if (!isOpen || initialMode !== 'sell') return;

    const wallet = walletAddress
      ?? (typeof window !== 'undefined' ? (window as any).solana?.publicKey?.toString() : null);

    if (!wallet) {
      setAmount(defaultSellAmount ? String(defaultSellAmount) : '');
      return;
    }

    setBalanceLoading(true);
    fetch('/api/solana/token-balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, mint: tokenAddress }),
    })
      .then(r => r.json())
      .then(({ balance, decimals }) => {
        const bal: number = balance ?? defaultSellAmount ?? 0;
        const dec: number = decimals ?? 6;
        setRealBalance(bal);
        setRealDecimals(dec);
        // Pre-fill with the FULL real balance (so 100% is the default)
        setAmount(bal > 0 ? String(bal) : (defaultSellAmount ? String(defaultSellAmount) : ''));
      })
      .catch(() => {
        setAmount(defaultSellAmount ? String(defaultSellAmount) : '');
      })
      .finally(() => setBalanceLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialMode, tokenAddress]);

  useEffect(() => {
    if (isOpen) {
      if (initialMode === 'buy') setAmount('');
      setTxState('idle');
      setTxSig('');
      setErrMsg('');
      setBoughtAmount(0);
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose();
  };

  const parsedAmount = parseFloat(amount) || 0;
  const estimatedOut =
    mode === 'buy'
      ? tokenPrice > 0 ? parsedAmount / tokenPrice : 0
      : parsedAmount * tokenPrice;

  const estimateLabel =
    mode === 'buy'
      ? `≈ ${estimatedOut.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${tokenSymbol}`
      : `≈ ${estimatedOut.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;

  // ── Execute swap ─────────────────────────────────────────────────────────────
  const executeSwap = async () => {
    if (!parsedAmount || parsedAmount <= 0) return;
    const solana = (window as any).solana;
    if (!solana?.isPhantom) {
      setErrMsg('Phantom wallet not found. Install from phantom.com');
      setTxState('error');
      return;
    }
    try {
      if (!solana.publicKey) await solana.connect();
      const walletPubkey: string = solana.publicKey.toString();
      const inputMint  = mode === 'buy' ? SOL_MINT : tokenAddress;
      const outputMint = mode === 'buy' ? tokenAddress : SOL_MINT;

      // Use higher slippage for sells on volatile pump.fun tokens
      const slippageBps = mode === 'buy' ? 500 : 2000; // 5% buy, 20% sell

      // For sell: use the decimals we already fetched from on-chain balance query
      const tokenDecimals = mode === 'sell' ? realDecimals : 6;

      const rawAmount = mode === 'buy'
        ? Math.round(parsedAmount * SOL_LAMPORTS)
        : Math.round(parsedAmount * Math.pow(10, tokenDecimals));

      setTxState('quoting');
      const quoteRes = await fetch(
        `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${rawAmount}&slippageBps=${slippageBps}`,
      );
      if (!quoteRes.ok) throw new Error(`Could not get quote (HTTP ${quoteRes.status}). The token may have low liquidity.`);
      const quoteResponse = await quoteRes.json();
      if (quoteResponse.error) throw new Error(`Jupiter: ${quoteResponse.error}`);
      if (!quoteResponse.outAmount) throw new Error('No route found. The token may have insufficient liquidity to sell right now.');

      setTxState('confirming');
      const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: walletPubkey,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });
      if (!swapRes.ok) throw new Error(`Failed to build transaction (HTTP ${swapRes.status})`);
      const swapData = await swapRes.json();
      if (swapData.error) throw new Error(`Swap error: ${swapData.error}`);

      setTxState('signing');
      const txBytes = Uint8Array.from(atob(swapData.swapTransaction), c => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(txBytes);

      setTxState('sending');
      const result = await solana.signAndSendTransaction(tx);
      const signature: string = result.signature ?? result;

      if (mode === 'buy') {
        const outAmount = parseInt(quoteResponse.outAmount ?? '0', 10) / Math.pow(10, tokenDecimals);
        setBoughtAmount(outAmount);
        saveHolding({
          address:       tokenAddress,
          symbol:        tokenSymbol,
          name:          tokenSymbol,
          logoURI:       logoURI ?? '',
          amountHeld:    outAmount,
          totalSolSpent: parsedAmount,
          avgPrice:      tokenPrice,
          boughtAt:      Date.now(),
        });
        // Notify MemecoinHoldings to refresh
        window.dispatchEvent(new CustomEvent('ember:holdings-updated'));
      }
      if (mode === 'sell') {
        window.dispatchEvent(new CustomEvent('ember:holdings-updated'));
        onSellSuccess?.();
      }

      setTxSig(signature);
      setTxState('success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface user-friendly explanations for common failures
      if (msg.includes('User rejected') || msg.includes('rejected')) {
        setErrMsg('Transaction cancelled in Phantom.');
      } else if (msg.includes('insufficient') || msg.includes('Insufficient')) {
        setErrMsg('Insufficient balance. Check your wallet has enough tokens and SOL for fees.');
      } else if (msg.includes('route') || msg.includes('liquidity')) {
        setErrMsg('No swap route found. This token may have very low liquidity right now.');
      } else if (msg.includes('simulation failed') || msg.includes('0x1')) {
        setErrMsg('Transaction simulation failed. Try reducing the amount or wait a moment.');
      } else {
        setErrMsg(msg);
      }
      setTxState('error');
    }
  };

  const isBusy = ['quoting', 'confirming', 'signing', 'sending'].includes(txState);

  const busyLabel: Record<TxState, string> = {
    idle:       '',
    quoting:    'Finding best route…',
    confirming: 'Building transaction…',
    signing:    'Waiting for signature…',
    sending:    'Broadcasting…',
    success:    '',
    error:      '',
  };

  // ─ colour tokens ─
  const accent      = mode === 'buy' ? '#4ade80' : '#fb7185';
  const accentDim   = mode === 'buy' ? 'rgba(74,222,128,0.12)' : 'rgba(251,113,133,0.12)';
  const accentBorder= mode === 'buy' ? 'rgba(74,222,128,0.25)' : 'rgba(251,113,133,0.25)';
  const accentGlow  = mode === 'buy' ? 'rgba(74,222,128,0.08)' : 'rgba(251,113,133,0.08)';

  // ── Portal wrapper so modal always renders above every stacking context ──────
  const Overlay = ({ children }: { children: React.ReactNode }) => {
    if (!mounted) return null;
    return createPortal(
      <div
        ref={overlayRef}
        onClick={handleOverlayClick}
        className="fixed inset-0 flex items-center justify-center p-4"
        style={{ zIndex: 99999, background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(14px)' }}
      >
        {children}
      </div>,
      document.body,
    );
  };

  // ── Success screen ──────────────────────────────────────────────────────────
  if (txState === 'success') {
    return (
      <Overlay>
        <div className="relative w-full max-w-sm rounded-3xl overflow-hidden"
          style={{ background: '#111113', border: '1px solid rgba(255,255,255,0.08)' }}>

          {/* glow strip */}
          <div className="h-0.5 w-full" style={{ background: 'linear-gradient(90deg, transparent, #4ade80 40%, transparent)' }} />

          <div className="px-6 py-8 flex flex-col items-center gap-4 text-center">
            {/* confetti ring */}
            <div className="relative">
              <div className="absolute inset-0 rounded-full blur-xl opacity-40" style={{ background: '#4ade80' }} />
              <div className="relative rounded-full ring-4 ring-[#4ade80]/30 p-1">
                <TokenAvatar logoURI={logoURI} symbol={tokenSymbol} size={56} />
              </div>
            </div>

            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold mb-3"
                style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' }}>
                <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><path d="M10.28 1.28L4.5 7.06 1.72 4.28 0 6l4.5 4.5 7.5-8L10.28 1.28z"/></svg>
                {mode === 'buy' ? 'Purchase confirmed' : 'Sale confirmed'}
              </div>
              {mode === 'buy' && boughtAmount > 0 ? (
                <p className="text-[26px] font-bold tracking-tight" style={{ color: '#f5f5f7' }}>
                  +{boughtAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                  <span style={{ color: '#4ade80' }}>{tokenSymbol}</span>
                </p>
              ) : (
                <p className="text-[26px] font-bold tracking-tight" style={{ color: '#f5f5f7' }}>{tokenSymbol} sold</p>
              )}
              <a href={`https://solscan.io/tx/${txSig}`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-[11px] underline underline-offset-2 transition-colors"
                style={{ color: '#52525b' }}>
                View on Solscan
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
              </a>
            </div>

            <div className="flex gap-2 w-full pt-1">
              {mode === 'buy' && (
                <button onClick={() => { setMode('sell'); setTxState('idle'); setTxSig(''); setAmount(''); setBoughtAmount(0); }}
                  className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold transition-all"
                  style={{ background: 'rgba(251,113,133,0.12)', color: '#fb7185', border: '1px solid rgba(251,113,133,0.2)' }}>
                  Sell
                </button>
              )}
              {mode === 'sell' && (
                <button onClick={() => { setMode('buy'); setTxState('idle'); setTxSig(''); setAmount(''); setBoughtAmount(0); }}
                  className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold transition-all"
                  style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' }}>
                  Buy more
                </button>
              )}
              <button onClick={onClose}
                className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold transition-all"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.08)' }}>
                Done
              </button>
            </div>
          </div>
        </div>
      </Overlay>
    );
  }

  // ── Main trade UI ────────────────────────────────────────────────────────────
  return (
    <Overlay>
      <div className="relative w-full max-w-sm rounded-3xl overflow-hidden"
        style={{ background: '#111113', border: '1px solid rgba(255,255,255,0.08)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}>

        {/* top accent strip */}
        <div className="h-0.5 w-full transition-all duration-300"
          style={{ background: `linear-gradient(90deg, transparent, ${accent} 40%, transparent)` }} />

        {/* Close */}
        <button onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full transition-all"
          style={{ color: '#52525b', background: 'rgba(255,255,255,0.04)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
          aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>

        {/* ─ Token header ─ */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <TokenAvatar logoURI={logoURI} symbol={tokenSymbol} size={40} />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold leading-none mb-0.5" style={{ color: '#f5f5f7' }}>
                {mode === 'buy' ? 'Buy' : 'Sell'}{' '}
                <span style={{ color: accent }}>${tokenSymbol}</span>
              </p>
              <p className="text-[11px]" style={{ color: '#52525b' }}>
                via Jupiter · best route auto-selected
              </p>
            </div>
          </div>

          {/* Buy / Sell toggle — pill style */}
          <div className="flex p-1 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <button onClick={() => setMode('buy')}
              className="flex-1 py-2 rounded-lg text-[12px] font-semibold transition-all duration-200"
              style={mode === 'buy'
                ? { background: 'rgba(74,222,128,0.15)', color: '#4ade80', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }
                : { background: 'transparent', color: '#52525b' }}>
              Buy
            </button>
            <button onClick={() => setMode('sell')}
              className="flex-1 py-2 rounded-lg text-[12px] font-semibold transition-all duration-200"
              style={mode === 'sell'
                ? { background: 'rgba(251,113,133,0.15)', color: '#fb7185', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }
                : { background: 'transparent', color: '#52525b' }}>
              Sell
            </button>
          </div>
        </div>

        {/* ─ Body ─ */}
        <div className="px-5 pb-5 space-y-3">

          {/* Real balance display for sell mode */}
          {mode === 'sell' && (
            <div className="flex items-center justify-between text-[11px]" style={{ color: '#52525b' }}>
              <span>Wallet balance</span>
              {balanceLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner color="#52525b" />
                  <span>Fetching…</span>
                </span>
              ) : (
                <button
                  className="font-semibold transition-colors"
                  style={{ color: realBalance != null ? '#a1a1aa' : '#52525b' }}
                  onClick={() => realBalance != null && setAmount(String(realBalance))}
                >
                  {realBalance != null
                    ? `${realBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${tokenSymbol}`
                    : '—'}
                </button>
              )}
            </div>
          )}

          {/* Quick presets */}
          <div className="grid grid-cols-4 gap-1.5">
            {(mode === 'buy' ? BUY_PRESETS : SELL_PRESETS).map(p => {
              // Use real on-chain balance for sell presets
              const sellBase = realBalance ?? defaultSellAmount ?? 0;
              const isActive = mode === 'buy'
                ? amount === p
                : (() => {
                    const pct = parseInt(p) / 100;
                    return sellBase > 0 && Math.abs(parseFloat(amount) - sellBase * pct) < 0.000001;
                  })();

              return (
                <button key={p} disabled={isBusy || (mode === 'sell' && balanceLoading)}
                  onClick={() => {
                    if (mode === 'buy') {
                      setAmount(p);
                    } else {
                      const pct = parseInt(p) / 100;
                      const base = realBalance ?? defaultSellAmount ?? 0;
                      setAmount(base > 0 ? String(base * pct) : '');
                    }
                  }}
                  className="py-2 rounded-lg text-[12px] font-semibold transition-all duration-150"
                  style={isActive
                    ? { background: accentDim, color: accent, border: `1px solid ${accentBorder}` }
                    : { background: 'rgba(255,255,255,0.04)', color: '#71717a', border: '1px solid rgba(255,255,255,0.06)' }}>
                  {p}
                </button>
              );
            })}
          </div>

          {/* Amount input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-semibold tracking-widest uppercase" style={{ color: '#52525b' }}>
                {mode === 'buy' ? 'Amount (SOL)' : `Amount (${tokenSymbol})`}
              </label>
              {parsedAmount > 0 && !balanceLoading && (
                <span className="text-[11px]" style={{ color: '#52525b' }}>{estimateLabel}</span>
              )}
            </div>
            <div className="relative">
              <input
                type="number" min="0" step="any"
                placeholder={mode === 'buy' ? '0.0' : '0'}
                value={amount}
                onChange={e => setAmount(e.target.value)}
                disabled={isBusy}
                className="w-full px-4 py-3.5 rounded-xl text-[18px] font-semibold outline-none transition-all num"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${parsedAmount > 0 ? accentBorder : 'rgba(255,255,255,0.07)'}`,
                  color: '#f5f5f7',
                  boxShadow: parsedAmount > 0 ? `0 0 0 3px ${accentGlow}` : 'none',
                }} />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium px-2 py-0.5 rounded-md"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#71717a' }}>
                {mode === 'buy' ? 'SOL' : tokenSymbol}
              </div>
            </div>
          </div>

          {/* No wallet warning */}
          {hasPhantom === false && (
            <div className="flex items-start gap-2.5 rounded-xl px-3.5 py-3"
              style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-0.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <p className="text-[11px] leading-relaxed" style={{ color: '#ca8a04' }}>
                Phantom not detected.{' '}
                <a href="https://phantom.com" target="_blank" rel="noopener noreferrer" className="underline">Install Phantom</a>
                {' '}to trade.
              </p>
            </div>
          )}

          {/* Busy progress */}
          {isBusy && (
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl"
              style={{ background: `${accentGlow}`, border: `1px solid ${accentBorder}` }}>
              <Spinner color={accent} />
              <span className="text-[12px] font-medium" style={{ color: accent }}>{busyLabel[txState]}</span>
            </div>
          )}

          {/* Error */}
          {txState === 'error' && (
            <div className="flex items-start gap-2.5 rounded-xl px-3.5 py-3"
              style={{ background: 'rgba(251,113,133,0.06)', border: '1px solid rgba(251,113,133,0.2)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb7185" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <p className="text-[11px] leading-relaxed break-all" style={{ color: '#fb7185' }}>{errMsg}</p>
            </div>
          )}

          {/* CTA */}
          {txState !== 'error' ? (
            <button
              onClick={executeSwap}
              disabled={isBusy || !parsedAmount || parsedAmount <= 0 || hasPhantom === false}
              className="w-full py-3.5 rounded-xl text-[14px] font-bold tracking-tight transition-all duration-200 disabled:opacity-30"
              style={{
                background: `linear-gradient(135deg, ${accent}22 0%, ${accent}18 100%)`,
                color: accent,
                border: `1px solid ${accentBorder}`,
                boxShadow: parsedAmount > 0 && !isBusy ? `0 4px 20px -4px ${accent}30` : 'none',
              }}>
              {isBusy ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner color={accent} />
                  {busyLabel[txState]}
                </span>
              ) : (
                `${mode === 'buy' ? 'Buy' : 'Sell'} ${tokenSymbol}`
              )}
            </button>
          ) : (
            <button onClick={() => { setTxState('idle'); setErrMsg(''); }}
              className="w-full py-3.5 rounded-xl text-[13px] font-semibold transition-all"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.08)' }}>
              Try again
            </button>
          )}

          <p className="text-center text-[10px]" style={{ color: '#3f3f46' }}>
            20% slippage · via Jupiter · verify CA before trading
          </p>
        </div>
      </div>
    </Overlay>
  );
}
