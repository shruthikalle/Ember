'use client';

import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import MetaMaskButton from '@/src/components/MetaMaskButton';
import PerpsChatInterface from '@/src/components/PerpsChatInterface';
import HyperCoreLiveFeed from '@/src/components/HyperCoreLiveFeed';

const TradingViewChart = lazy(() => import('@/src/components/TradingViewChart'));

interface Market {
  coin: string;          // Hyperliquid coin symbol (e.g. "ETH")
  label: string;         // Display label
  symbol: string;        // TradingView symbol (e.g. "COINBASE:ETHUSD")
}

const MARKETS: Market[] = [
  { coin: 'BTC',  label: 'BTC-USD',  symbol: 'COINBASE:BTCUSD' },
  { coin: 'ETH',  label: 'ETH-USD',  symbol: 'COINBASE:ETHUSD' },
  { coin: 'SOL',  label: 'SOL-USD',  symbol: 'COINBASE:SOLUSD' },
  { coin: 'AVAX', label: 'AVAX-USD', symbol: 'COINBASE:AVAXUSD' },
  { coin: 'DOGE', label: 'DOGE-USD', symbol: 'BINANCE:DOGEUSDT' },
  { coin: 'LINK', label: 'LINK-USD', symbol: 'COINBASE:LINKUSD' },
];

interface MarketStats {
  markPx: string;
  oraclePx: string;
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  prevDayPx: string;
  maxLeverage: number;
}

type PriceFlash = 'up' | 'down' | null;

export default function PerpsPage() {
  const [selectedMarket, setSelectedMarket] = useState(MARKETS[1]); // ETH default
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [showSelector, setShowSelector] = useState(false);
  const [flash, setFlash] = useState<PriceFlash>(null);
  const prevMarkRef = useRef<number | null>(null);

  // Wallet sync
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).ethereum) return;
    const eth = (window as any).ethereum;
    const sync = async () => {
      try {
        const accounts = await eth.request({ method: 'eth_accounts' });
        setIsWalletConnected(accounts.length > 0);
      } catch { /* ignore */ }
    };
    sync();
    const onAccountsChanged = (accounts: string[]) => setIsWalletConnected(accounts.length > 0);
    eth.on?.('accountsChanged', onAccountsChanged);
    return () => eth.removeListener?.('accountsChanged', onAccountsChanged);
  }, []);

  // Fetch market stats for the selected coin (poll every 5s)
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/perps/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> = data?.[0]?.universe || [];
      const ctxs: Array<MarketStats & { name?: string }> = data?.[1] || [];
      const idx = universe.findIndex((u) => u.name === selectedMarket.coin);
      if (idx === -1) return;
      const ctx = ctxs[idx];
      if (!ctx) return;
      setStats({
        markPx: ctx.markPx,
        oraclePx: ctx.oraclePx,
        funding: ctx.funding,
        openInterest: ctx.openInterest,
        dayNtlVlm: ctx.dayNtlVlm,
        prevDayPx: ctx.prevDayPx,
        maxLeverage: universe[idx].maxLeverage,
      });
    } catch (err) {
      console.warn('[Perps] Stats fetch failed:', err);
    }
  }, [selectedMarket.coin]);

  useEffect(() => {
    setStats(null);
    prevMarkRef.current = null;
    fetchStats();
    const t = setInterval(fetchStats, 5000);
    return () => clearInterval(t);
  }, [fetchStats]);

  const mark = stats ? parseFloat(stats.markPx) : null;
  const prev = stats ? parseFloat(stats.prevDayPx) : null;
  const change = mark !== null && prev ? mark - prev : null;
  const changePct = mark !== null && prev ? ((mark - prev) / prev) * 100 : null;
  const fundingPct = stats ? parseFloat(stats.funding) * 100 : null;
  const oi = stats ? parseFloat(stats.openInterest) : null;
  const vol = stats ? parseFloat(stats.dayNtlVlm) : null;

  // Flash effect on mark price tick
  useEffect(() => {
    if (mark === null) return;
    const last = prevMarkRef.current;
    if (last !== null && last !== mark) {
      setFlash(mark > last ? 'up' : 'down');
      const t = window.setTimeout(() => setFlash(null), 600);
      prevMarkRef.current = mark;
      return () => clearTimeout(t);
    }
    prevMarkRef.current = mark;
  }, [mark]);

  const fmtUsd = (n: number) => {
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
    return `$${n.toFixed(2)}`;
  };

  const coinGradient = (coin: string) =>
    coin === 'BTC' ? 'from-amber-400 to-orange-500'
    : coin === 'ETH' ? 'from-slate-300 to-slate-500'
    : coin === 'SOL' ? 'from-purple-400 to-cyan-400'
    : coin === 'AVAX' ? 'from-red-400 to-rose-600'
    : coin === 'DOGE' ? 'from-yellow-300 to-amber-500'
    : coin === 'LINK' ? 'from-blue-400 to-indigo-500'
    : 'from-purple-500 to-pink-500';

  return (
    <div className="relative h-screen flex flex-col overflow-hidden" style={{ background: '#09090b' }}>
      {/* Subtle warm backdrop — matches homepage aesthetic */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px]"
          style={{ background: 'radial-gradient(ellipse at center, rgba(255,122,61,0.08) 0%, transparent 70%)' }}
        />
      </div>

      {/* ─── Top nav ─────────────────────────────────────────────── */}
      <header className="relative z-30 border-b border-white/[0.06] bg-[#09090b]/80 backdrop-blur-xl flex-shrink-0">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <a href="/" className="flex items-center">
              <span className="text-[18px] font-black tracking-[0.18em] text-white">EMBER</span>
            </a>
            <nav className="hidden md:flex items-center gap-1">
              <a href="/" className="btn-ghost">Home</a>
              <a href="/#try-it" className="btn-ghost">Swap</a>
              <span className="btn-ghost !text-[var(--color-accent)]">Perps</span>
              <a href="/predictions" className="btn-ghost">Predictions</a>
              <a href="/memecoins" className="btn-ghost">Memecoins</a>
              <a href="/earn" className="btn-ghost">Earn</a>
              <a href="/#activity" className="btn-ghost">Activity</a>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden lg:block">
              <HyperCoreLiveFeed />
            </div>
            {!isWalletConnected && <MetaMaskButton />}
          </div>
        </div>
      </header>

      {/* ─── Market stats bar ────────────────────────────────────── */}
      <div className="relative z-20 border-b border-white/[0.06] bg-[#0a0a0f]/70 backdrop-blur-xl flex-shrink-0 overflow-visible">
        <div className="px-4 py-2.5 flex items-center gap-4">
          {/* Token selector */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowSelector((s) => !s)}
              className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-all ${
                showSelector ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
              }`}
            >
              <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${coinGradient(selectedMarket.coin)} flex items-center justify-center text-[11px] font-black text-white shadow-[0_4px_12px_-4px_rgba(0,0,0,0.6)]`}>
                {selectedMarket.coin.slice(0, 1)}
              </div>
              <div className="flex flex-col items-start leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="text-[14px] font-bold text-white tracking-tight">{selectedMarket.label}</span>
                  <span className="text-[9px] font-bold text-[#ff7a3d] bg-[#ff7a3d]/10 border border-[#ff7a3d]/20 px-1 py-0.5 rounded">PERP</span>
                </div>
                {stats && (
                  <span className="text-[9px] text-white/40 font-medium tracking-wide mt-0.5">
                    Up to {stats.maxLeverage}× leverage
                  </span>
                )}
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`text-white/40 transition-transform ${showSelector ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {showSelector && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowSelector(false)} />
                <div className="absolute top-full left-0 mt-2 w-64 rounded-xl border border-white/10 bg-[#0a0a0f]/95 backdrop-blur-xl shadow-[0_20px_50px_-15px_rgba(0,0,0,0.8)] z-50 p-1 overflow-hidden">
                  <div className="px-3 py-2 text-[9px] font-bold tracking-[0.15em] uppercase text-white/30 border-b border-white/[0.04] mb-1">
                    Markets
                  </div>
                  {MARKETS.map((m) => (
                    <button
                      key={m.coin}
                      onClick={() => { setSelectedMarket(m); setShowSelector(false); }}
                      className={`w-full flex items-center gap-3 px-2.5 py-2 text-[13px] text-left rounded-lg transition-all ${
                        m.coin === selectedMarket.coin
                          ? 'bg-white/[0.06] text-white'
                          : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <div className={`w-7 h-7 rounded-full bg-gradient-to-br ${coinGradient(m.coin)} flex items-center justify-center text-[10px] font-black text-white`}>
                        {m.coin.slice(0, 1)}
                      </div>
                      <span className="flex-1 font-semibold">{m.label}</span>
                      {m.coin === selectedMarket.coin && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff7a3d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="h-9 w-px bg-white/[0.06] flex-shrink-0" />

          {/* Mark price — prominent */}
          <div className="flex flex-col flex-shrink-0">
            <span className="text-[9px] font-bold text-white/40 tracking-[0.12em] uppercase">Mark</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`text-[18px] font-bold tabular-nums leading-none transition-colors duration-300 ${
                flash === 'up' ? 'text-emerald-400' : flash === 'down' ? 'text-red-400' : 'text-white'
              }`}>
                {mark !== null ? `$${mark.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
              </span>
              <span className={`w-1.5 h-1.5 rounded-full ${stats ? 'bg-emerald-400 animate-pulse' : 'bg-white/20'}`} />
            </div>
          </div>

          {/* Remaining stats — horizontally scrollable */}
          <div className="flex items-center gap-5 overflow-x-auto min-w-0 flex-1 scrollbar-thin pl-1">
            <Stat
              label="Oracle"
              value={stats ? `$${parseFloat(stats.oraclePx).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
            />
            <Stat
              label="24h Change"
              value={
                change !== null
                  ? `${change >= 0 ? '+' : '−'}$${Math.abs(change).toFixed(2)}`
                  : '—'
              }
              sub={changePct !== null ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` : undefined}
              tone={change === null ? undefined : change >= 0 ? 'up' : 'down'}
              arrow={change === null ? undefined : change >= 0 ? 'up' : 'down'}
            />
            <Stat label="24h Volume" value={vol !== null ? fmtUsd(vol) : '—'} />
            <Stat label="Open Interest" value={oi !== null && mark !== null ? fmtUsd(oi * mark) : '—'} />
            <Stat
              label="Funding (1h)"
              value={fundingPct !== null ? `${fundingPct >= 0 ? '+' : ''}${(fundingPct * 100).toFixed(4)}%` : '—'}
              tone={fundingPct === null ? undefined : fundingPct >= 0 ? 'down' : 'up'}
            />
          </div>
        </div>
      </div>

      {/* ─── Main: Chart (left) + Chat (right) ───────────────────── */}
      <main className="relative z-10 flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_420px] xl:grid-cols-[1fr_460px] gap-3 p-3">
        {/* Chart panel — TradingView renders its own native chrome */}
        <div className="relative rounded-xl border border-white/[0.06] bg-[#0a0a0f]/60 backdrop-blur-xl overflow-hidden flex flex-col min-h-[400px]">
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#ff7a3d]/30 to-transparent pointer-events-none z-10" />
          <div className="flex-1 min-h-0">
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full gap-3 text-white/40">
                  <div className="w-4 h-4 border-2 border-white/10 border-t-[#ff7a3d] rounded-full animate-spin" />
                  <span className="text-[13px]">Loading chart…</span>
                </div>
              }
            >
              <TradingViewChart symbol={selectedMarket.symbol} interval="60" height="100%" />
            </Suspense>
          </div>
        </div>

        {/* Chat panel */}
        <div className="relative rounded-xl border border-white/[0.06] bg-[#0a0a0f]/60 backdrop-blur-xl overflow-hidden flex flex-col min-h-0">
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#ff7a3d]/30 to-transparent pointer-events-none" />
          <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] flex-shrink-0">
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-bold text-white tracking-tight leading-tight">AI Analyst</h2>
              <p className="text-[10px] text-white/40 leading-tight mt-0.5">
                Trade {selectedMarket.coin} · longs &amp; shorts
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">
              <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          </div>
          <div className="flex-1 min-h-0 p-3">
            <PerpsChatInterface defaultCoin={selectedMarket.coin} />
          </div>
        </div>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  arrow,
  prominent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down';
  arrow?: 'up' | 'down';
  prominent?: boolean;
}) {
  const valueColor =
    tone === 'up' ? 'text-emerald-400' :
    tone === 'down' ? 'text-red-400' :
    'text-white';
  return (
    <div className="flex flex-col flex-shrink-0">
      <span className="text-[9px] font-bold text-white/40 tracking-[0.12em] uppercase">{label}</span>
      <div className={`${prominent ? 'text-[15px] font-bold' : 'text-[13px] font-semibold'} ${valueColor} tabular-nums mt-0.5 flex items-center gap-1`}>
        {arrow && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            {arrow === 'up' ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
          </svg>
        )}
        <span>{value}</span>
        {sub && <span className="text-[10.5px] font-semibold opacity-75 ml-0.5">{sub}</span>}
      </div>
    </div>
  );
}
