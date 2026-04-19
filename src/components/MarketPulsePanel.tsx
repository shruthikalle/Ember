'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PulseWhale {
  address: string;
  name: string | null;
  pseudonym: string | null;
  profileImage: string | null;
  recentAction: 'BUY' | 'SELL';
  recentOutcome: 'Yes' | 'No';
  recentSize: number;
  recentPrice: number;
  recentTimestamp: number;
  recentNotional: number;
  walletTotalValue: number | null;
  walletTotalPnl: number | null;
  walletPnlPct: number | null;
  walletMarketsOpen: number | null;
}

interface MarketPulse {
  conditionId: string;
  tokenId: string;
  priceNow: number | null;
  delta1h: number | null;
  delta24h: number | null;
  tradeCount1h: number;
  tradeVolumeUsd1h: number;
  tradeCount24h: number;
  whales: PulseWhale[];
}

interface Props {
  slug: string;
  recommendedSide?: 'Yes' | 'No' | null;
  analysisReady?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}pp`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtAgo(ts: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function walletLabel(w: PulseWhale): string {
  if (w.name && w.name.trim()) return w.name;
  if (w.pseudonym && w.pseudonym.trim()) return w.pseudonym;
  return `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
}

// Bearish (No): aligned = BUY No OR SELL Yes
// Bullish (Yes): aligned = BUY Yes OR SELL No
function isAlignedWhale(w: PulseWhale, recommendedSide: 'Yes' | 'No' | null): boolean {
  if (!recommendedSide) return true;
  const opposite = recommendedSide === 'Yes' ? 'No' : 'Yes';
  return (
    (w.recentAction === 'BUY' && w.recentOutcome === recommendedSide) ||
    (w.recentAction === 'SELL' && w.recentOutcome === opposite)
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/[0.05] ${className}`} />;
}

// ─── WhaleRow ─────────────────────────────────────────────────────────────────

function WhaleRow({ w, idx }: { w: PulseWhale; idx: number }) {
  const sideColor =
    w.recentAction === 'BUY'
      ? w.recentOutcome === 'Yes' ? 'text-emerald-400' : 'text-red-400'
      : w.recentOutcome === 'Yes' ? 'text-red-300' : 'text-emerald-300';

  return (
    <motion.a
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: idx * 0.04 }}
      href={`https://polymarket.com/profile/${w.address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.03] transition-colors"
    >
      <div className="w-6 h-6 rounded-full overflow-hidden bg-white/[0.05] flex-shrink-0">
        {w.profileImage && (
          <img src={w.profileImage} alt="" className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] font-semibold text-white tracking-tight truncate">
            {walletLabel(w)}
          </span>
          {w.walletPnlPct !== null && (
            <span className="text-[10px] font-bold text-emerald-400 tracking-tight flex-shrink-0">
              {fmtPct(w.walletPnlPct)} ROI
            </span>
          )}
        </div>
        <div className="text-[10px] text-white/30 leading-tight tracking-tight">
          <span className={`font-semibold ${sideColor}`}>
            {w.recentAction} {w.recentOutcome}
          </span>
          {' · '}
          <span>{fmtUsd(w.recentNotional)}</span>
          {' · '}
          <span>{fmtAgo(w.recentTimestamp)}</span>
        </div>
      </div>

      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.5" className="text-white/15 flex-shrink-0">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </motion.a>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MarketPulsePanel({ slug, recommendedSide = null, analysisReady = false }: Props) {
  const [pulse, setPulse] = useState<MarketPulse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!analysisReady) return;
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(
          `/api/predictions/market-pulse?slug=${encodeURIComponent(slug)}&whaleLimit=10`,
          { cache: 'no-store' },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setPulse(data as MarketPulse);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [slug, analysisReady]);

  if (!analysisReady) return null;

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading && !pulse) {
    return (
      <div className="bg-[#0d0d0d] rounded-xl p-4 border border-white/[0.07]">
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70 mb-3">
          Market Pulse
        </p>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg bg-black/40 p-2.5 border border-white/[0.05]">
              <Skeleton className="h-2 w-6 mb-2" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
        <Skeleton className="h-2.5 w-24 mb-2" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2 py-2">
            <Skeleton className="w-6 h-6 rounded-full flex-shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-2 w-36" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error || !pulse) {
    return (
      <div className="bg-[#0d0d0d] rounded-xl p-4 border border-white/[0.07]">
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70 mb-2">
          Market Pulse
        </p>
        <p className="text-xs text-white/30 tracking-tight">{error || 'Unavailable'}</p>
      </div>
    );
  }

  const delta1hColor =
    pulse.delta1h === null ? 'text-white/30'
    : pulse.delta1h > 0.3 ? 'text-emerald-400'
    : pulse.delta1h < -0.3 ? 'text-red-400'
    : 'text-yellow-500';

  const delta24hColor =
    pulse.delta24h === null ? 'text-white/30'
    : pulse.delta24h > 1 ? 'text-emerald-400'
    : pulse.delta24h < -1 ? 'text-red-400'
    : 'text-yellow-500';

  // Top 3 most profitable whales whose recent trade matches the recommended side.
  // Already sorted by walletPnlPct desc from the API; take the top 3 aligned ones.
  const topProfitableWhales = pulse.whales
    .filter((w) => isAlignedWhale(w, recommendedSide))
    .slice(0, 3);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[#0d0d0d] rounded-xl p-4 border border-white/[0.07]"
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70">
          Market Pulse
        </p>
        <span className="text-[10px] text-white/25 tracking-tight">
          {pulse.tradeCount1h} trades · {fmtUsd(pulse.tradeVolumeUsd1h)} last hour
        </span>
      </div>

      {/* Price deltas */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {[
          { label: 'Now', value: pulse.priceNow !== null ? `${(pulse.priceNow * 100).toFixed(1)}¢` : '—', color: 'text-white' },
          { label: '1h', value: fmtPp(pulse.delta1h), color: delta1hColor },
          { label: '24h', value: fmtPp(pulse.delta24h), color: delta24hColor },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-lg bg-black/40 p-2.5 border border-white/[0.05]">
            <p className="text-[9px] text-white/25 uppercase tracking-[0.12em]">{label}</p>
            <p className={`text-sm font-bold tracking-tight mt-0.5 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Whale feed */}
      {topProfitableWhales.length === 0 ? (
        <p className="text-[11px] text-white/20 text-center py-3 tracking-tight italic">
          No smart money activity in last 24h
        </p>
      ) : (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 mb-2">
            <p className="text-[9px] text-white/25 font-bold uppercase tracking-[0.12em]">
              Most Profitable
            </p>
            {recommendedSide && (
              <span className={`text-[9px] font-bold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded-md ${
                recommendedSide === 'Yes'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-red-500/10 text-red-400'
              }`}>
                Betting {recommendedSide}
              </span>
            )}
          </div>
          <AnimatePresence>
            {topProfitableWhales.map((w, idx) => (
              <WhaleRow key={w.address + w.recentTimestamp} w={w} idx={idx} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
