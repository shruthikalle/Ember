'use client';

import { useEffect, useState } from 'react';

interface SimilarPair {
  similarity: number;
  spread: number | null;
  polymarket: {
    id: string;
    question: string;
    slug: string;
    image: string | null;
    yesPrice: number | null;
    volume24h: number;
    liquidity: number;
    url: string;
  };
  kalshi: {
    ticker: string;
    eventTicker: string;
    title: string;
    subtitle: string | null;
    yesPrice: number | null;
    volume24h: number;
    liquidity: number;
    url: string;
  };
}

function formatCompact(n: number | null | undefined): string {
  const v = typeof n === 'number' ? n : 0;
  if (!isFinite(v)) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export default function CrossExchangeMarkets() {
  const [pairs, setPairs] = useState<SimilarPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState<{ polyCount: number; kalshiCount: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/predictions/similar?limit=50&minScore=0.40');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;
        setPairs(data.pairs || []);
        setMeta({ polyCount: data.polyCount ?? 0, kalshiCount: data.kalshiCount ?? 0 });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[12px] text-trading-text-dim">
          Ranked by semantic similarity (OpenAI embeddings). Spread = Polymarket YES − Kalshi YES.
        </div>
        {meta && (
          <div className="text-[11px] text-trading-text-dim">
            {meta.polyCount} Polymarket × {meta.kalshiCount} Kalshi scanned
          </div>
        )}
      </div>

      {error && (
        <div className="panel border-trading-red/20 bg-trading-red-dim text-trading-red text-sm p-4 rounded-xl">
          {error}
          {error.includes('OPENAI_API_KEY') && (
            <div className="mt-2 text-xs text-trading-text-dim">
              Set <code className="mono">OPENAI_API_KEY</code> in your <code className="mono">.env</code> to enable embedding-based matching.
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="flex items-center gap-3 text-trading-text-dim">
            <div className="w-5 h-5 border-2 border-trading-accent/40 border-t-trading-accent rounded-full animate-spin" />
            Embedding markets and matching across exchanges…
          </div>
        </div>
      )}

      {!loading && !error && pairs.length === 0 && (
        <div className="text-center py-12 text-trading-text-dim text-sm">
          No similar markets found above threshold.
        </div>
      )}

      <div className="space-y-3">
        {pairs.map((p) => (
          <PairCard key={`${p.polymarket.id}-${p.kalshi.ticker}`} pair={p} />
        ))}
      </div>
    </div>
  );
}

function PairCard({ pair }: { pair: SimilarPair }) {
  const { polymarket: pm, kalshi: km, similarity, spread } = pair;
  const simPct = Math.round(similarity * 100);

  const spreadAbs = spread !== null ? Math.abs(spread) : null;
  const spreadEdge = spreadAbs !== null && spreadAbs >= 0.05;
  const spreadColor = spreadEdge ? 'text-emerald-400' : 'text-trading-text-dim';
  const spreadBg = spreadEdge
    ? 'bg-emerald-500/10 border-emerald-500/20'
    : 'bg-white/[0.04] border-white/[0.06]';

  return (
    <div className="relative panel hover:border-trading-border-light transition-colors overflow-hidden p-0">
      <div className="p-4 space-y-3">
        {/* Header: badges */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-gradient-to-r from-[#ff7a3d] to-[#ff5722] text-white shadow-[0_0_14px_-3px_rgba(255,122,61,0.55)]">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 3h6l4 4v10l-4 4H9l-4-4V7z" />
                <path d="M12 8v8M8 12h8" />
              </svg>
              ARB
            </span>
            <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-white/[0.04] text-trading-text-dim border border-white/[0.06]">
              {simPct}% match
            </span>
          </div>
          {spread !== null && (
            <span className={`inline-flex items-center text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md border ${spreadBg} ${spreadColor}`}>
              SPREAD {spread >= 0 ? '+' : ''}{(spread * 100).toFixed(1)}PP
            </span>
          )}
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Two exchange sides */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ExchangePanel
            label="Polymarket"
            accent="#ff7a3d"
            title={pm.question}
            subtitle={null}
            image={pm.image}
            yesPrice={pm.yesPrice}
            volume24h={pm.volume24h}
            liquidity={pm.liquidity}
            url={pm.url}
          />
          <ExchangePanel
            label="Kalshi"
            accent="#00d09c"
            title={km.title}
            subtitle={km.subtitle}
            image={null}
            yesPrice={km.yesPrice}
            volume24h={km.volume24h}
            liquidity={km.liquidity}
            url={km.url}
          />
        </div>
      </div>
    </div>
  );
}

function ExchangePanel({
  label,
  accent,
  title,
  subtitle,
  image,
  yesPrice,
  volume24h,
  liquidity,
  url,
}: {
  label: string;
  accent: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  yesPrice: number | null;
  volume24h: number;
  liquidity: number;
  url: string;
}) {
  const yesPct = yesPrice !== null ? Math.round(yesPrice * 100) : null;
  const noPct = yesPct !== null ? 100 - yesPct : null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block rounded-xl bg-trading-bg/50 border border-trading-border p-3 hover:border-trading-border-light transition-colors overflow-hidden"
    >
      {/* Top accent line */}
      <div
        className="absolute top-0 left-0 right-0 h-px opacity-60 pointer-events-none"
        style={{ background: `linear-gradient(to right, transparent, ${accent}66, transparent)` }}
      />

      <div className="flex items-start gap-3">
        {image ? (
          <div className="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-trading-surface-2">
            <img
              src={image}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        ) : (
          <div
            className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-[11px] font-black text-white"
            style={{ background: `linear-gradient(135deg, ${accent}, ${accent}99)` }}
          >
            {label[0]}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border"
              style={{ color: accent, borderColor: `${accent}33`, background: `${accent}14` }}
            >
              {label}
            </span>
          </div>
          <p className="text-[13px] font-semibold text-trading-text leading-snug line-clamp-2">
            {title}
          </p>
          {subtitle && (
            <p className="text-[11px] text-trading-text-dim mt-1 line-clamp-1">{subtitle}</p>
          )}
        </div>
      </div>

      {yesPct !== null && noPct !== null && (
        <>
          <div className="flex items-center justify-between mt-3">
            <div className="text-left">
              <p className="text-[9px] text-trading-text-dim uppercase tracking-wide">YES</p>
              <p className="text-[16px] font-bold text-emerald-400 tabular-nums leading-none mt-0.5">{yesPct}%</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] text-trading-text-dim uppercase tracking-wide">NO</p>
              <p className="text-[16px] font-bold text-rose-400 tabular-nums leading-none mt-0.5">{noPct}%</p>
            </div>
          </div>

          <div className="relative h-2 bg-rose-500/80 rounded-sm overflow-hidden mt-2">
            <div
              className="absolute top-0 left-0 h-full bg-emerald-500 transition-all duration-500 ease-out"
              style={{ width: `${yesPct}%` }}
            />
            <div
              className="absolute top-[-25%] h-[150%] w-1.5 bg-trading-bg"
              style={{ left: `${yesPct}%`, transform: 'translateX(-100%) skewX(-15deg)' }}
            />
          </div>
        </>
      )}

      <div className="flex items-center justify-between mt-2 text-[10px] text-trading-text-dim">
        <span>24H {formatCompact(volume24h)}</span>
        <span>LIQ {formatCompact(liquidity)}</span>
        <span
          className="inline-flex items-center gap-0.5 font-semibold"
          style={{ color: accent }}
        >
          Open
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5">
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </span>
      </div>
    </a>
  );
}
