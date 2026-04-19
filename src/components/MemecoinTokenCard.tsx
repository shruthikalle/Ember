'use client';

import { useEffect, useState, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SecurityData {
  ownershipPercentage: number;
  creatorPercentage: number;
  top10HolderPercent: number;
  lpBurnedPercent: number;
  price: number;
  priceChange24hPercent: number;
  volume24hUSD: number;
  marketcap: number;
  holder: number;
  riskScore: number;
  signal: 'bullish' | 'bearish' | 'neutral';
}

interface WhaleTx {
  type: 'buy' | 'sell';
  amountUSD: number;
  timestamp: number; // unix seconds
}

interface MemecoinTokenCardProps {
  address: string;
  symbol: string;
  onBuy: () => void;
  onSell: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// Color logic
function top10Color(pct: number): string {
  if (pct < 20) return '#4ade80';
  if (pct <= 40) return '#facc15';
  return '#fb7185';
}

function devColor(pct: number): string {
  if (pct < 1) return '#4ade80';
  if (pct <= 5) return '#facc15';
  return '#fb7185';
}

function lpColor(pct: number): string {
  if (pct >= 100) return '#4ade80';
  if (pct >= 80) return '#facc15';
  return '#fb7185';
}

function riskColor(score: number): string {
  if (score > 65) return '#4ade80';
  if (score >= 40) return '#facc15';
  return '#fb7185';
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div
      className="rounded-2xl p-4 animate-pulse"
      style={{ background: 'rgba(22,22,26,0.8)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div className="grid grid-cols-3 gap-3 mb-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="h-5 w-16 bg-white/10 rounded mb-2" />
            <div className="h-3 w-12 bg-white/8 rounded" />
          </div>
        ))}
      </div>
      <div className="h-8 bg-white/10 rounded-xl mb-3" />
      <div className="flex gap-2">
        <div className="flex-1 h-10 bg-white/10 rounded-full" />
        <div className="flex-1 h-10 bg-white/10 rounded-full" />
      </div>
    </div>
  );
}

// ─── Stat Box ─────────────────────────────────────────────────────────────────

interface StatBoxProps {
  icon: string;
  label: string;
  value: string;
  valueColor: string;
}

function StatBox({ icon, label, value, valueColor }: StatBoxProps) {
  return (
    <div
      className="rounded-xl p-3 flex flex-col gap-1"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <span className="text-[18px] font-bold num" style={{ color: valueColor }}>
        {value}
      </span>
      <span className="text-[10px] font-medium tracking-wide uppercase flex items-center gap-1" style={{ color: '#71717a' }}>
        <span>{icon}</span>
        {label}
      </span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MemecoinTokenCard({ address, symbol, onBuy, onSell }: MemecoinTokenCardProps) {
  const [security, setSecurity] = useState<SecurityData | null>(null);
  const [whales, setWhales] = useState<WhaleTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [secRes, whaleRes] = await Promise.all([
        fetch(`/api/birdeye/security?address=${address}`),
        fetch(`/api/birdeye/whales?address=${address}&limit=10`),
      ]);

      if (!secRes.ok) throw new Error(`Security fetch failed: HTTP ${secRes.status}`);
      const secData: SecurityData = await secRes.json();
      setSecurity(secData);

      if (whaleRes.ok) {
        const wData = await whaleRes.json();
        const list: WhaleTx[] = Array.isArray(wData) ? wData : (wData.transactions ?? wData.data ?? []);
        setWhales(list.slice(0, 5));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load token data');
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };

  if (loading) return <CardSkeleton />;

  if (error) {
    return (
      <div
        className="rounded-2xl p-4 text-center text-[13px]"
        style={{ background: 'rgba(22,22,26,0.8)', border: '1px solid rgba(255,255,255,0.08)', color: '#fb7185' }}
      >
        {error}
        <button onClick={fetchData} className="ml-2 underline underline-offset-2" style={{ color: '#ff7a3d' }}>
          Retry
        </button>
      </div>
    );
  }

  if (!security) return null;

  // Signal badge
  const signalConfig = {
    bullish: { label: 'Bullish Signal', dot: '🟢', color: '#4ade80', bg: 'rgba(74,222,128,0.1)', border: 'rgba(74,222,128,0.25)' },
    bearish: { label: 'Bearish Signal', dot: '🔴', color: '#fb7185', bg: 'rgba(251,113,133,0.1)', border: 'rgba(251,113,133,0.25)' },
    neutral: { label: 'Neutral', dot: '🟡', color: '#facc15', bg: 'rgba(250,204,21,0.1)', border: 'rgba(250,204,21,0.25)' },
  }[security.signal];

  const shortCA = `CA: ${address.slice(0, 8)}...${address.slice(-4)}`;

  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: 'rgba(16,16,20,0.9)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {/* Signal badge */}
      <div className="flex items-center justify-between mb-4">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold"
          style={{
            color: signalConfig.color,
            background: signalConfig.bg,
            border: `1px solid ${signalConfig.border}`,
          }}
        >
          {signalConfig.dot} {signalConfig.label}
        </span>

        {/* CA copy */}
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-all duration-150"
          style={{
            color: copied ? '#4ade80' : '#a1a1aa',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
          title="Copy contract address"
        >
          {shortCA}
          {copied ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>

      {/* Stats grid: 3 cols × 2 rows */}
      <div className="grid grid-cols-3 gap-2.5 mb-4">
        {/* Row 1 */}
        <StatBox
          icon="👥"
          label="Top 10 H.%"
          value={`${security.top10HolderPercent.toFixed(1)}%`}
          valueColor={top10Color(security.top10HolderPercent)}
        />
        <StatBox
          icon="🧑‍💻"
          label="Dev H.%"
          value={`${security.creatorPercentage.toFixed(2)}%`}
          valueColor={devColor(security.creatorPercentage)}
        />
        <StatBox
          icon="🔥"
          label="LP Burned%"
          value={`${security.lpBurnedPercent.toFixed(0)}%`}
          valueColor={lpColor(security.lpBurnedPercent)}
        />

        {/* Row 2 */}
        <StatBox
          icon="📊"
          label="Holders"
          value={security.holder >= 1000 ? `${(security.holder / 1000).toFixed(1)}K` : String(security.holder)}
          valueColor="#a1a1aa"
        />
        <StatBox
          icon="💰"
          label="Volume 24h"
          value={formatCompact(security.volume24hUSD)}
          valueColor="#a1a1aa"
        />
        <StatBox
          icon="🛡"
          label="Risk Score"
          value={String(security.riskScore)}
          valueColor={riskColor(security.riskScore)}
        />
      </div>

      {/* Whale feed */}
      {whales.length > 0 && (
        <div
          className="rounded-xl p-3 mb-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[10px] font-medium uppercase tracking-widest mb-2" style={{ color: '#52525b' }}>
            Whale Activity
          </p>
          <div className="flex flex-col gap-1.5">
            {whales.map((tx, i) => {
              const isBuy = tx.type === 'buy';
              return (
                <div key={i} className="flex items-center justify-between text-[12px]">
                  <span style={{ color: isBuy ? '#4ade80' : '#fb7185' }}>
                    🐋 {isBuy ? 'Buy' : 'Sell'} {formatUSD(tx.amountUSD)}
                  </span>
                  <span style={{ color: '#52525b' }}>{timeAgo(tx.timestamp)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Buy / Sell buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBuy}
          className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-full text-[13px] font-semibold transition-all duration-200"
          style={{
            background: 'rgba(74,222,128,0.12)',
            color: '#4ade80',
            border: '1px solid rgba(74,222,128,0.3)',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(74,222,128,0.2)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(74,222,128,0.12)';
          }}
        >
          🟢 Buy {symbol}
        </button>
        <button
          type="button"
          onClick={onSell}
          className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-full text-[13px] font-semibold transition-all duration-200"
          style={{
            background: 'rgba(251,113,133,0.12)',
            color: '#fb7185',
            border: '1px solid rgba(251,113,133,0.3)',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(251,113,133,0.2)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(251,113,133,0.12)';
          }}
        >
          🔴 Sell {symbol}
        </button>
      </div>
    </div>
  );
}
