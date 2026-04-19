'use client';

import { useCallback, useEffect, useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Position {
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;               // "Yes" | "No"
  outcomeIndex: number;
  tokenId: string;
  oppositeTokenId: string;
  conditionId: string;
  negRisk: boolean;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  initialValue: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  endDate: string;
  redeemable: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PredictionPositions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [closingSlug, setClosingSlug] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<Record<string, string>>({});

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/predictions/positions', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPositions(data.positions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  const closePosition = useCallback(async (p: Position) => {
    const key = `${p.slug}:${p.outcome}`;
    setClosingSlug(key);
    setCloseError((e) => ({ ...e, [key]: '' }));
    try {
      const res = await fetch('/api/predictions/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: p.slug,
          outcome: p.outcome,
          shares: p.shares,
          tokenId: p.tokenId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Optimistic refresh after a short delay (CLOB takes a sec to settle)
      setTimeout(() => { fetchPositions(); }, 1500);
    } catch (err) {
      setCloseError((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setClosingSlug(null);
    }
  }, [fetchPositions]);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading && positions.length === 0) {
    return (
      <div className="flex items-center justify-center gap-3 py-8 text-[var(--color-text-dim)]">
        <div className="w-4 h-4 border-2 border-[var(--color-accent)]/30 border-t-[var(--color-accent)] rounded-full animate-spin" />
        <span className="text-sm">Loading positions...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4 text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-8 text-center">
        <p className="text-sm text-[var(--color-text-dim)]">No open positions yet.</p>
        <p className="text-[11px] text-[var(--color-text-mute)] mt-1">Place a bet from the markets below and it'll show up here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Your Positions</h3>
          <span className="text-[11px] text-[var(--color-text-dim)]">{positions.length} open</span>
        </div>
        <button
          onClick={fetchPositions}
          className="text-[11px] text-[var(--color-text-dim)] hover:text-[var(--color-text)] transition-colors"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="space-y-2">
        {positions.map((p) => {
          const key = `${p.slug}:${p.outcome}`;
          const isClosing = closingSlug === key;
          const err = closeError[key];
          const isYes = p.outcome.toLowerCase() === 'yes';
          const pnlPositive = p.pnl >= 0;
          const pnlStr = `${pnlPositive ? '+' : ''}$${p.pnl.toFixed(2)} (${pnlPositive ? '+' : ''}${p.pnlPct.toFixed(1)}%)`;
          const endLabel = p.endDate
            ? new Date(p.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : null;

          return (
            <div
              key={key}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
            >
              <div className="flex items-start gap-3">
                {p.icon && (
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-[var(--color-surface)]">
                    <img
                      src={p.icon}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-[var(--color-text)] leading-tight">
                    {p.title}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--color-text-mute)]">
                    <span className={`font-semibold ${isYes ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.outcome.toUpperCase()}
                    </span>
                    <span>·</span>
                    <span>{p.shares.toFixed(2)} shares</span>
                    <span>·</span>
                    <span>avg {(p.avgPrice * 100).toFixed(1)}¢</span>
                    {endLabel && (
                      <>
                        <span>·</span>
                        <span>Ends {endLabel}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <div className="text-sm font-semibold text-[var(--color-text)]">
                    ${p.currentValue.toFixed(2)}
                  </div>
                  <div className={`text-[10px] font-medium ${pnlPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pnlStr}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-3">
                {p.redeemable ? (
                  <div className="flex-1 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-md py-1.5 text-center">
                    Market resolved — redeem on polymarket.com
                  </div>
                ) : (
                  <button
                    onClick={() => closePosition(p)}
                    disabled={isClosing}
                    className="flex-1 text-[11px] font-semibold py-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent)]/[0.04] text-[var(--color-text)] transition-all disabled:opacity-50"
                  >
                    {isClosing ? 'Closing…' : `Close @ ${(p.currentPrice * 100).toFixed(1)}¢`}
                  </button>
                )}
                <a
                  href={`https://polymarket.com/event/${p.eventSlug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] px-2.5 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:border-[var(--color-border-light)] transition-all"
                >
                  View ↗
                </a>
              </div>

              {err && (
                <p className="mt-2 text-[11px] text-red-400">{err}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
