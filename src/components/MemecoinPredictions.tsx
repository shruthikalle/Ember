'use client';

import { useEffect, useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TokenInput {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24hPercent: number;
  riskScore?: number;
  signal?: string;
}

interface PredictionMarket {
  tokenAddress: string;
  tokenSymbol: string;
  question: string;
  yesVotes: number;
  noVotes: number;
  userVote: 'yes' | 'no' | null;
  signal: 'bullish' | 'bearish' | 'neutral';
  priceAtCreation: number;
  expiresAt: number;
  smartSignalScore: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeSignal(raw?: string): 'bullish' | 'bearish' | 'neutral' {
  if (!raw) return 'neutral';
  const s = raw.toLowerCase();
  if (s === 'bullish') return 'bullish';
  if (s === 'bearish') return 'bearish';
  return 'neutral';
}

function seedVotes(signal: 'bullish' | 'bearish' | 'neutral'): { yes: number; no: number } {
  if (signal === 'bullish') return { yes: randBetween(60, 80), no: randBetween(20, 40) };
  if (signal === 'bearish') return { yes: randBetween(20, 40), no: randBetween(60, 80) };
  return { yes: randBetween(40, 60), no: randBetween(40, 60) };
}

function smartSignalExplanation(score: number, signal: 'bullish' | 'bearish' | 'neutral'): string {
  if (signal === 'bullish' && score >= 70) return 'LP fully burned + low insider % → suggests healthy token';
  if (signal === 'bullish') return 'Moderate buy pressure + decent liquidity → cautiously bullish';
  if (signal === 'bearish' && score < 40) return 'High insider concentration + thin liquidity → risky';
  if (signal === 'bearish') return 'Sell pressure dominates recent 24h volume';
  return 'Mixed signals — balanced buy/sell pressure, neutral outlook';
}

function useCountdown(expiresAt: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const diff = Math.max(0, expiresAt - now);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 animate-pulse space-y-4">
      <div className="flex items-start gap-3">
        <div className="h-6 w-14 rounded-full bg-white/10" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/4 bg-white/10 rounded" />
          <div className="h-3 w-1/3 bg-white/8 rounded" />
        </div>
      </div>
      <div className="h-2 w-full bg-white/10 rounded-full" />
      <div className="flex gap-2">
        <div className="h-9 flex-1 bg-white/10 rounded-full" />
        <div className="h-9 flex-1 bg-white/10 rounded-full" />
      </div>
    </div>
  );
}

// ─── Single Market Card ───────────────────────────────────────────────────────

function MarketCard({
  market,
  onVote,
}: {
  market: PredictionMarket;
  onVote: (address: string, vote: 'yes' | 'no') => void;
}) {
  const total = market.yesVotes + market.noVotes || 1;
  const yesPct = Math.round((market.yesVotes / total) * 100);
  const noPct = 100 - yesPct;
  const countdown = useCountdown(market.expiresAt);

  const signalColor =
    market.signal === 'bullish'
      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25'
      : market.signal === 'bearish'
      ? 'text-red-400 bg-red-500/10 border-red-500/25'
      : 'text-yellow-400 bg-yellow-500/10 border-yellow-500/25';

  const signalLabel =
    market.signal === 'bullish' ? 'Bullish' : market.signal === 'bearish' ? 'Bearish' : 'Neutral';

  const signalDot =
    market.signal === 'bullish' ? '🟢' : market.signal === 'bearish' ? '🔴' : '🟡';

  const explanation = smartSignalExplanation(market.smartSignalScore, market.signal);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 flex flex-col gap-4 transition-all duration-200 hover:border-[var(--color-border-strong)]">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-accent)] shrink-0">
          ${market.tokenSymbol}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-[var(--color-text)] leading-snug">
            {market.question}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${signalColor}`}
            >
              {signalDot} {signalLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="w-full h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden flex">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${yesPct}%`, background: 'linear-gradient(90deg, #4ade80 0%, #22c55e 100%)' }}
          />
          <div
            className="h-full flex-1 rounded-full"
            style={{ background: '#fb7185' }}
          />
        </div>
        <p className="text-[11px] text-[var(--color-text-mute)]">
          Community:{' '}
          <span className="text-emerald-400 font-medium">{yesPct}% YES</span>
          {' · '}
          <span className="text-red-400 font-medium">{noPct}% NO</span>
          {' · '}
          <span>{market.yesVotes + market.noVotes} votes</span>
        </p>
      </div>

      {/* Vote buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => onVote(market.tokenAddress, 'yes')}
          className={`flex-1 text-[13px] font-semibold py-2 rounded-full border transition-all duration-200 ${
            market.userVote === 'yes'
              ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
              : 'bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-emerald-500/40 hover:text-emerald-400 hover:bg-emerald-500/10'
          }`}
        >
          YES ✓
        </button>
        <button
          onClick={() => onVote(market.tokenAddress, 'no')}
          className={`flex-1 text-[13px] font-semibold py-2 rounded-full border transition-all duration-200 ${
            market.userVote === 'no'
              ? 'bg-red-500/20 border-red-500/60 text-red-300'
              : 'bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/10'
          }`}
        >
          NO ✗
        </button>
      </div>

      {/* Smart Signal */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3.5 py-3 space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-mute)]">
          Smart Signal
        </p>
        <p className="text-[12px] text-[var(--color-text-dim)] leading-relaxed">{explanation}</p>
        <div className="flex items-center gap-1.5 mt-1">
          <div className="flex-1 h-1 rounded-full bg-[var(--color-surface)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${market.smartSignalScore}%`,
                background: 'linear-gradient(90deg, #ff7a3d 0%, #ff5722 100%)',
              }}
            />
          </div>
          <span className="text-[10px] text-[var(--color-text-mute)] tabular-nums">
            {market.smartSignalScore}/100
          </span>
        </div>
      </div>

      {/* Expiry */}
      <p className="text-[11px] text-[var(--color-text-mute)]">
        Resolves in{' '}
        <span className="text-[var(--color-text-dim)] font-medium">{countdown}</span>
      </p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface MemecoinPredictionsProps {
  tokens: TokenInput[];
}

export default function MemecoinPredictions({ tokens }: MemecoinPredictionsProps) {
  const [markets, setMarkets] = useState<PredictionMarket[]>([]);

  // Build markets whenever tokens change
  useEffect(() => {
    if (!tokens.length) return;

    const now = Date.now();

    const built = tokens.map((t) => {
      const signal = normalizeSignal(t.signal);
      const seeds = seedVotes(signal);
      const score = t.riskScore != null ? Math.round(t.riskScore) : randBetween(30, 90);

      // Restore user vote from localStorage
      let userVote: 'yes' | 'no' | null = null;
      try {
        const stored = localStorage.getItem(`memecoin_votes_${t.address}`);
        if (stored === 'yes' || stored === 'no') userVote = stored;
      } catch { /* ignore */ }

      const market: PredictionMarket = {
        tokenAddress: t.address,
        tokenSymbol: t.symbol,
        question: `Will $${t.symbol} be up 10%+ in the next 24h?`,
        yesVotes: seeds.yes + (userVote === 'yes' ? 1 : 0),
        noVotes: seeds.no + (userVote === 'no' ? 1 : 0),
        userVote,
        signal,
        priceAtCreation: t.price,
        expiresAt: now + 24 * 60 * 60 * 1000,
        smartSignalScore: score,
      };
      return market;
    });

    setMarkets(built);
  }, [tokens]);

  const handleVote = (tokenAddress: string, vote: 'yes' | 'no') => {
    setMarkets((prev) =>
      prev.map((m) => {
        if (m.tokenAddress !== tokenAddress) return m;

        const wasVotedSame = m.userVote === vote;
        let newYes = m.yesVotes;
        let newNo = m.noVotes;

        // Remove previous vote contribution
        if (m.userVote === 'yes') newYes = Math.max(0, newYes - 1);
        if (m.userVote === 'no') newNo = Math.max(0, newNo - 1);

        const newUserVote = wasVotedSame ? null : vote;

        // Add new vote
        if (newUserVote === 'yes') newYes += 1;
        if (newUserVote === 'no') newNo += 1;

        try {
          if (newUserVote) {
            localStorage.setItem(`memecoin_votes_${tokenAddress}`, newUserVote);
          } else {
            localStorage.removeItem(`memecoin_votes_${tokenAddress}`);
          }
        } catch { /* ignore */ }

        return { ...m, yesVotes: newYes, noVotes: newNo, userVote: newUserVote };
      })
    );
  };

  if (!tokens.length) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {markets.map((m) => (
        <MarketCard key={m.tokenAddress} market={m} onVote={handleVote} />
      ))}
    </div>
  );
}
