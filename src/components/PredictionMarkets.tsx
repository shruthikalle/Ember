'use client';

import { useEffect, useState, useCallback } from 'react';
import PredictionTradeWidget from './PredictionTradeWidget';
import CrossExchangeMarkets from './CrossExchangeMarkets';

// ─── Types (mirrored from polymarket.ts for client use) ─────────────────────

interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  description: string;
  endDateIso?: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  volume: string;
  volumeNum?: number;
  volume24hr?: number;
  liquidity: string;
  liquidityNum?: number;
  outcomes: string;
  outcomePrices: string;
  conditionId: string;
  image: string;
  icon: string;
  clobTokenIds?: string;
  negRisk?: boolean;
}

interface TradePrefill {
  marketSlug: string;
  action: 'BUY_YES' | 'BUY_NO';
  marketQuestion: string;
  marketImage?: string;
  outcomePrices: string[];
  outcomes: string[];
  tokenIds?: { yes: string; no: string };
}

interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  startDate?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  volume: number;
  volume24hr: number;
  liquidity: number;
  markets: PolymarketMarket[];
  image: string;
  icon: string;
  tags: { id: string; label: string; slug: string }[];
}

interface Tag {
  id: string;
  label: string;
  slug: string;
}

interface ArbOpportunity {
  similarity: number;
  kalshi: {
    ticker: string;
    title: string;
    subtitle: string | null;
    yesPrice: number | null;
    volume24h: number;
    liquidity: number;
    url: string;
  };
  arb: {
    polyYes: number;
    kalshiYes: number;
    spread: number;
    direction: {
      buyYesOn: 'polymarket' | 'kalshi';
      buyNoOn: 'polymarket' | 'kalshi';
    };
    costPerPair: number;
    grossPerPair: number;
    pairs: number;
    deployedUsd: number;
    grossProfitUsd: number;
    polyFeesUsd: number;
    kalshiFeesUsd: number;
    netProfitUsd: number;
    roi: number;
    profitable: boolean;
  };
}

interface AnalysisResult {
  marketProbability: number;
  agentProbability: number;
  edge: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  reasoning: string[];
  sources: { title: string; url: string }[];
  recommendedAction: 'BUY_YES' | 'BUY_NO' | 'PASS';
  degraded?: boolean;
  arbOpportunity?: ArbOpportunity | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeParse(str: string | undefined): string[] {
  if (!str) return [];
  try { return JSON.parse(str); } catch { return []; }
}

function formatCompact(n: number | string | undefined | null): string {
  const v = typeof n === 'string' ? parseFloat(n) : (n ?? 0);
  if (!isFinite(v)) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function pctFromPrice(p: string): string {
  return `${(parseFloat(p) * 100).toFixed(0)}%`;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface PredictionMarketsProps {
  walletAddress: string | null;
  onConnectWallet: () => Promise<string | null>;
}

export default function PredictionMarkets({ walletAddress, onConnectWallet }: PredictionMarketsProps) {
  const [events, setEvents] = useState<PolymarketEvent[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PolymarketMarket[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [tradePrefill, setTradePrefill] = useState<TradePrefill | null>(null);
  const [activeTab, setActiveTab] = useState<'polymarket' | 'cross'>('polymarket');
  // Once the Cross-Exchange tab is visited for the first time we keep the
  // component mounted (just hidden) so the data is never re-fetched.
  const [crossEverShown, setCrossEverShown] = useState(false);
  const LIMIT = 20;

  const handleTradeClick = useCallback((market: PolymarketMarket, action: 'BUY_YES' | 'BUY_NO') => {
    const prices = safeParse(market.outcomePrices);
    const outcomes = safeParse(market.outcomes);
    // Parse clobTokenIds to pass directly to trade route
    let tokenIds: { yes: string; no: string } | undefined;
    if (market.clobTokenIds) {
      try {
        const ids = JSON.parse(market.clobTokenIds);
        if (Array.isArray(ids) && ids.length >= 2) {
          tokenIds = { yes: ids[0], no: ids[1] };
        }
      } catch { /* ignore */ }
    }
    setTradePrefill({
      marketSlug: market.slug,
      action,
      marketQuestion: market.question,
      marketImage: market.image,
      outcomePrices: prices,
      outcomes,
      tokenIds,
    });
  }, []);

  // ── Fetch events ────────────────────────────────────────────────────────
  const fetchEvents = useCallback(async (reset = false) => {
    setLoading(true);
    setError('');
    setSearchResults(null);

    const newOffset = reset ? 0 : offset;
    const params = new URLSearchParams({
      limit: String(LIMIT),
      offset: String(newOffset),
      tags: reset ? 'true' : 'false',
      ...(selectedTag ? { tag_id: selectedTag } : {}),
    });

    try {
      const res = await fetch(`/api/predictions?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();

      if (reset) {
        setEvents(data.events || []);
        if (data.tags) setTags(data.tags);
        setOffset(LIMIT);
      } else {
        setEvents((prev) => [...prev, ...(data.events || [])]);
        setOffset((prev) => prev + LIMIT);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [offset, selectedTag]);

  // ── Search ──────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`/api/predictions?q=${encodeURIComponent(searchQuery.trim())}&limit=30`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      setSearchResults(data.markets || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  // ── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    fetchEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTag]);

  // ── Search debounce ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const t = setTimeout(handleSearch, 400);
    return () => clearTimeout(t);
  }, [searchQuery, handleSearch]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      {/* ─── Tabs ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-trading-border">
        <button
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative -mb-px ${
            activeTab === 'polymarket'
              ? 'text-trading-text border-b-2 border-trading-accent'
              : 'text-trading-text-dim hover:text-trading-text border-b-2 border-transparent'
          }`}
          onClick={() => setActiveTab('polymarket')}
        >
          Polymarket
        </button>
        <button
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative -mb-px flex items-center gap-1.5 ${
            activeTab === 'cross'
              ? 'text-trading-text border-b-2 border-trading-accent'
              : 'text-trading-text-dim hover:text-trading-text border-b-2 border-transparent'
          }`}
          onClick={() => { setActiveTab('cross'); setCrossEverShown(true); }}
        >
          Cross-Exchange
          <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-trading-accent/10 text-trading-accent">
            Kalshi
          </span>
        </button>
      </div>

      {/* Cross-Exchange: mount once on first visit, then stay mounted (hidden)
          so the expensive embedding fetch is never re-triggered. */}
      {crossEverShown && (
        <div style={{ display: activeTab === 'cross' ? 'block' : 'none' }}>
          <CrossExchangeMarkets />
        </div>
      )}

      {activeTab === 'polymarket' && (
      <>
      {/* ─── Search + Filters ─────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="relative">
          <input
            className="input-field pl-10 text-base"
            placeholder="Search prediction markets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-trading-text-dim"
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        {/* Tag filters */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                !selectedTag
                  ? 'bg-trading-accent text-white border-trading-accent'
                  : 'bg-trading-surface-2 border-trading-border text-trading-text-dim hover:text-trading-text hover:border-trading-border-light'
              }`}
              onClick={() => setSelectedTag('')}
            >
              All
            </button>
            {tags.slice(0, 15).map((tag) => (
              <button
                key={tag.id}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  selectedTag === tag.id
                    ? 'bg-trading-accent text-white border-trading-accent'
                    : 'bg-trading-surface-2 border-trading-border text-trading-text-dim hover:text-trading-text hover:border-trading-border-light'
                }`}
                onClick={() => setSelectedTag(tag.id)}
              >
                {tag.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ─── Error ────────────────────────────────────────────────────── */}
      {error && (
        <div className="panel border-trading-red/20 bg-trading-red-dim text-trading-red text-sm p-4 rounded-xl">
          {error}
        </div>
      )}

      {/* ─── Search Results ───────────────────────────────────────────── */}
      {searchResults !== null && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-trading-text-secondary">
              Search results ({searchResults.length})
            </h3>
            <button
              className="text-xs text-trading-text-dim hover:text-trading-text transition-colors"
              onClick={() => { setSearchQuery(''); setSearchResults(null); }}
            >
              Clear search
            </button>
          </div>

          {searchResults.length === 0 && !loading && (
            <div className="text-center py-12 text-trading-text-dim text-sm">
              No markets found for &quot;{searchQuery}&quot;
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {searchResults.map((m) => (
              <MarketCard key={m.id} market={m} onTrade={handleTradeClick} />
            ))}
          </div>
        </div>
      )}

      {/* ─── Events Grid ─────────────────────────────────────────────── */}
      {searchResults === null && (
        <div className="space-y-4">
          {events.map((ev) => (
            <EventCard
              key={ev.id}
              event={ev}
              expanded={expandedEvent === ev.id}
              onToggle={() => setExpandedEvent(expandedEvent === ev.id ? null : ev.id)}
              onTrade={handleTradeClick}
            />
          ))}

          {/* Load more */}
          {!loading && events.length >= LIMIT && (
            <div className="flex justify-center pt-4">
              <button
                className="btn-secondary text-sm px-8 py-3"
                onClick={() => fetchEvents(false)}
              >
                Load More
              </button>
            </div>
          )}
        </div>
      )}

      {/* ─── Loading ──────────────────────────────────────────────────── */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="flex items-center gap-3 text-trading-text-dim">
            <div className="w-5 h-5 border-2 border-trading-accent/40 border-t-trading-accent rounded-full animate-spin" />
            Loading markets...
          </div>
        </div>
      )}

      </>
      )}

      {/* ─── Trade Widget Modal ────────────────────────────────────────── */}
      {tradePrefill && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-xl my-auto">
            <PredictionTradeWidget
              walletAddress={walletAddress}
              onConnectWallet={onConnectWallet}
              prefill={tradePrefill}
              onClose={() => setTradePrefill(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Event Card ─────────────────────────────────────────────────────────────

function EventCard({
  event,
  expanded,
  onToggle,
  onTrade,
}: {
  event: PolymarketEvent;
  expanded: boolean;
  onToggle: () => void;
  onTrade: (market: PolymarketMarket, action: 'BUY_YES' | 'BUY_NO') => void;
}) {
  const topMarket = event.markets[0];
  const topPrices = safeParse(topMarket?.outcomePrices);
  const topOutcomes = safeParse(topMarket?.outcomes);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

  // Use event-level image, fall back to first market image
  const imageUrl = event.image || topMarket?.image;

  const handleAnalyze = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (analysis) { setShowAnalysis(!showAnalysis); return; }
    setAnalyzing(true);
    setShowAnalysis(true);
    try {
      const slug = topMarket?.slug || event.slug;
      const res = await fetch('/api/predictions/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketSlug: slug }),
      });
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis ?? data);
      }
    } catch { /* ignore */ }
    setAnalyzing(false);
  };

  const isSingle = event.markets.length === 1;
  const yesPrice = parseFloat(topPrices[0] ?? '0');
  const yesPct = Math.round(yesPrice * 100);
  const noPct = 100 - yesPct;
  const isHot = (event.volume24hr ?? 0) >= 100_000;
  const daysLeft = event.endDate
    ? Math.max(0, Math.ceil((new Date(event.endDate).getTime() - Date.now()) / 86_400_000))
    : null;
  const primaryTag = event.tags?.[0];
  const timerPct = (() => {
    if (!event.endDate || !event.startDate) return null;
    const end = new Date(event.endDate).getTime();
    const start = new Date(event.startDate).getTime();
    const total = end - start;
    if (total <= 0) return null;
    const remaining = end - Date.now();
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  })();

  return (
    <div className="relative panel hover:border-trading-border-light transition-colors overflow-hidden p-0">
      <div className="p-4 space-y-3">
        {/* Header: badges + days-left pill */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isHot && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-gradient-to-r from-[#ff7a3d] to-[#ff5722] text-white shadow-[0_0_14px_-3px_rgba(255,122,61,0.55)]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1.5.5-2.5 1-3.5C9 8 10 10 10 10s-.5-2 0-4 2-4 2-4zm-1 10c1.5 0 2 1 2 2 0 2-2 3-2 5 0 0-3-1-3-4 0-2 2-3 3-3z" />
                </svg>
                HOT
              </span>
            )}
            {primaryTag && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-white/[0.04] text-trading-text-dim border border-white/[0.06]">
                {primaryTag.label}
              </span>
            )}
            {!isSingle && (
              <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-white/[0.04] text-trading-text-dim border border-white/[0.06]">
                {event.markets.length} markets
              </span>
            )}
          </div>
          {daysLeft !== null && (
            <span className="inline-flex items-center text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
              {daysLeft === 0 ? 'ENDING' : `${daysLeft}D`}
            </span>
          )}
        </div>

        {/* Question + thumbnail */}
        <div className="flex items-start gap-3 cursor-pointer" onClick={onToggle}>
          {imageUrl && (
            <div className="flex-shrink-0 w-11 h-11 rounded-xl overflow-hidden bg-trading-surface-2">
              <img
                src={imageUrl}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}
          <h3 className="flex-1 text-[15px] font-semibold leading-snug text-trading-text">
            {event.title}
          </h3>
          {!isSingle && (
            <svg
              className={`w-4 h-4 mt-1 text-trading-text-dim transition-transform ${expanded ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </div>

        {/* Gradient separator */}
        <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Stats row */}
        <div className="flex justify-between items-start gap-3">
          <div className="text-left">
            <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">Total Vol</p>
            <p className="text-[17px] font-bold text-yellow-400 tabular-nums leading-none mt-0.5">
              {formatCompact(event.volume)}
            </p>
          </div>
          <div className="text-left">
            <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">24H Vol</p>
            <p className="text-[17px] font-bold text-emerald-400 tabular-nums leading-none mt-0.5">
              {formatCompact(event.volume24hr)}
            </p>
          </div>
          <div className="text-left">
            <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">Liquidity</p>
            <p className="text-[17px] font-bold text-rose-400 tabular-nums leading-none mt-0.5">
              {formatCompact(event.liquidity)}
            </p>
          </div>
        </div>

        {/* Gradient separator */}
        <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Single-market: voting split + BET buttons */}
        {isSingle && topMarket && topOutcomes.length > 0 && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">
                    Voted <span className="font-bold">YES</span>
                  </p>
                  <p className="text-[22px] font-bold text-emerald-400 tabular-nums leading-none mt-0.5">{yesPct}%</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">
                    Voted <span className="font-bold">NO</span>
                  </p>
                  <p className="text-[22px] font-bold text-rose-400 tabular-nums leading-none mt-0.5">{noPct}%</p>
                </div>
              </div>

              {/* Progress bar with diagonal split */}
              <div className="relative h-2.5 bg-rose-500/80 rounded-sm overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full bg-emerald-500 transition-all duration-500 ease-out"
                  style={{ width: `${yesPct}%` }}
                />
                <div
                  className="absolute top-[-25%] h-[150%] w-2 bg-trading-bg"
                  style={{ left: `${yesPct}%`, transform: 'translateX(-100%) skewX(-15deg)' }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={(e) => { e.stopPropagation(); onTrade(topMarket, 'BUY_YES'); }}
                className="group relative overflow-hidden rounded-full py-2.5 text-[12px] font-bold tracking-wide bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-400/30 hover:border-emerald-300/50 transition-all"
              >
                <span className="relative z-10 inline-flex items-center justify-center gap-1">
                  BUY YES
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="7" y1="17" x2="17" y2="7" />
                    <polyline points="7 7 17 7 17 17" />
                  </svg>
                </span>
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-emerald-200/25 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 ease-out" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onTrade(topMarket, 'BUY_NO'); }}
                className="group relative overflow-hidden rounded-full py-2.5 text-[12px] font-bold tracking-wide bg-rose-600 hover:bg-rose-500 text-white border border-rose-400/30 hover:border-rose-300/50 transition-all"
              >
                <span className="relative z-10 inline-flex items-center justify-center gap-1">
                  BUY NO
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="7" y1="7" x2="17" y2="17" />
                    <polyline points="17 7 17 17 7 17" />
                  </svg>
                </span>
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-rose-200/25 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 ease-out" />
              </button>
            </div>

            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className={`w-full text-[11px] font-semibold py-1.5 rounded-md border transition-colors ${
                showAnalysis
                  ? 'bg-trading-accent/10 text-trading-accent border-trading-accent/30'
                  : 'bg-white/[0.02] text-trading-text-dim border-white/[0.06] hover:text-trading-text hover:border-white/[0.12]'
              }`}
            >
              {analyzing ? 'Analyzing…' : showAnalysis ? 'Hide Analysis' : 'Analyze with AI'}
            </button>

            {showAnalysis && <AnalysisPanel analysis={analysis} loading={analyzing} />}
          </>
        )}

        {/* Multi-market: expand hint */}
        {!isSingle && (
          <button
            onClick={onToggle}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/[0.06] hover:border-white/[0.1] transition-all"
          >
            <span className="text-[12px] font-medium text-trading-text">
              {expanded ? 'Hide markets' : 'View all markets'}
            </span>
            <svg className={`w-4 h-4 text-trading-text-dim transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {/* Expanded: show all markets in the event */}
      {expanded && !isSingle && (
        <div className="border-t border-trading-border bg-black/20 p-3 space-y-2">
          {[...event.markets]
            .sort((a, b) => {
              const aYes = parseFloat(safeParse(a.outcomePrices)[0] ?? '0');
              const bYes = parseFloat(safeParse(b.outcomePrices)[0] ?? '0');
              return bYes - aYes;
            })
            .map((m) => (
              <MarketRow key={m.id} market={m} onTrade={onTrade} />
            ))}
        </div>
      )}

      {/* Timer progress bar at bottom — orange gradient, drains toward end */}
      {timerPct !== null && (
        <div className="h-[3px] bg-white/[0.04] overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#ff7a3d] to-[#ff5722] transition-all"
            style={{ width: `${timerPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Market Row (inside expanded event) ────────────────────────────────────

function MarketRow({ market, onTrade }: { market: PolymarketMarket; onTrade: (market: PolymarketMarket, action: 'BUY_YES' | 'BUY_NO') => void }) {
  const prices = safeParse(market.outcomePrices);
  const outcomes = safeParse(market.outcomes);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const handleAnalyze = async () => {
    if (analysis) { setShowAnalysis(!showAnalysis); return; }
    setAnalyzing(true);
    setShowAnalysis(true);
    try {
      const res = await fetch('/api/predictions/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketSlug: market.slug }),
      });
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis ?? data);
      }
    } catch { /* ignore */ }
    setAnalyzing(false);
  };

  return (
    <div className="px-3 py-2 rounded-lg bg-trading-bg/50 hover:bg-trading-surface-2 transition-colors">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-trading-text-secondary truncate">
            {market.question}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {outcomes.map((outcome: string, i: number) => (
            <span
              key={outcome}
              className={`text-[11px] font-medium px-2 py-0.5 rounded-md ${
                i === 0
                  ? 'bg-trading-green-dim text-trading-green'
                  : 'bg-trading-red-dim text-trading-red'
              }`}
            >
              {outcome} {pctFromPrice(prices[i] ?? '0')}
            </span>
          ))}
          <button
            className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-trading-green/10 text-trading-green border border-trading-green/20 hover:bg-trading-green/20 transition-colors"
            onClick={() => onTrade(market, 'BUY_YES')}
          >
            Yes
          </button>
          <button
            className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-trading-red/10 text-trading-red border border-trading-red/20 hover:bg-trading-red/20 transition-colors"
            onClick={() => onTrade(market, 'BUY_NO')}
          >
            No
          </button>
          <button
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border transition-colors ${
              showAnalysis
                ? 'bg-trading-accent/10 text-trading-accent border-trading-accent/30'
                : 'bg-trading-surface-2 text-trading-text-dim border-trading-border hover:text-trading-text'
            }`}
            onClick={handleAnalyze}
            disabled={analyzing}
          >
            {analyzing ? '...' : 'Analyze'}
          </button>
          <span className="text-[11px] text-trading-text-dim ml-1">
            {formatCompact(market.volume24hr ?? 0)}
          </span>
        </div>
      </div>
      {showAnalysis && <AnalysisPanel analysis={analysis} loading={analyzing} />}
    </div>
  );
}

// ─── Analysis Panel ─────────────────────────────────────────────────────────

function AnalysisPanel({ analysis, loading }: { analysis: AnalysisResult | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="mt-3 pt-3 border-t border-trading-border">
        <div className="flex items-center gap-2 text-trading-text-dim text-xs">
          <div className="w-3.5 h-3.5 border-2 border-trading-accent/30 border-t-trading-accent rounded-full animate-spin" />
          Searching news & forming a view...
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const edgePp = analysis.edge * 100;
  const sentimentColor =
    analysis.sentiment === 'bullish' ? 'text-trading-green'
    : analysis.sentiment === 'bearish' ? 'text-trading-red'
    : 'text-yellow-500';

  return (
    <div className="mt-3 pt-3 border-t border-trading-border space-y-2.5">
      {/* Header: sentiment + edge */}
      <div className="flex items-center justify-between">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${sentimentColor}`}>
          {analysis.sentiment}
        </span>
        <span className={`text-[11px] font-semibold ${edgePp >= 0 ? 'text-trading-green' : 'text-trading-red'}`}>
          Edge {edgePp >= 0 ? '+' : ''}{edgePp.toFixed(1)}pp
        </span>
      </div>

      {/* Probabilities */}
      {!analysis.degraded && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-trading-bg/60 p-2 border border-trading-border/60">
            <p className="text-[9px] text-trading-text-dim uppercase tracking-wider">Market</p>
            <p className="text-sm font-semibold text-trading-text-secondary mt-0.5">
              {(analysis.marketProbability * 100).toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg bg-trading-bg/60 p-2 border border-trading-border/60">
            <p className="text-[9px] text-trading-text-dim uppercase tracking-wider">Agent</p>
            <p className="text-sm font-semibold text-trading-text mt-0.5">
              {(analysis.agentProbability * 100).toFixed(1)}%
            </p>
          </div>
        </div>
      )}

      {/* Summary */}
      {analysis.summary && (
        <p className="text-xs text-trading-text-secondary leading-relaxed">{analysis.summary}</p>
      )}

      {/* Reasoning bullets */}
      {analysis.reasoning?.length > 0 && (
        <ul className="space-y-1">
          {analysis.reasoning.map((r, i) => (
            <li key={i} className="text-[11px] text-trading-text-secondary leading-relaxed flex gap-1.5">
              <span className="text-trading-accent flex-shrink-0">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Cross-exchange arbitrage */}
      {analysis.arbOpportunity && (
        <ArbSection arb={analysis.arbOpportunity} />
      )}

      {/* Sources */}
      {analysis.sources && analysis.sources.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-trading-border/60">
          <p className="text-[10px] text-trading-text-dim font-medium uppercase tracking-wider pt-1">Sources</p>
          {analysis.sources.map((src, i) => (
            <a
              key={i}
              href={src.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[11px] text-trading-accent hover:text-trading-accent-hover transition-colors truncate"
            >
              {src.title}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Market Card (for search results) ──────────────────────────────────────

function MarketCard({ market, onTrade }: { market: PolymarketMarket; onTrade: (market: PolymarketMarket, action: 'BUY_YES' | 'BUY_NO') => void }) {
  const prices = safeParse(market.outcomePrices);
  const outcomes = safeParse(market.outcomes);
  const yesPrice = parseFloat(prices[0] ?? '0');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const handleAnalyze = async () => {
    if (analysis) {
      setShowAnalysis(!showAnalysis);
      return;
    }
    setAnalyzing(true);
    setShowAnalysis(true);
    try {
      const res = await fetch('/api/predictions/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketSlug: market.slug }),
      });
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis ?? data);
      }
    } catch { /* ignore */ }
    setAnalyzing(false);
  };

  const yesPct = Math.round(yesPrice * 100);
  const noPct = 100 - yesPct;
  const vol = market.volumeNum ?? parseFloat(market.volume || '0');
  const isHot = (market.volume24hr ?? 0) >= 100_000;

  return (
    <div className="relative panel hover:border-trading-border-light transition-colors overflow-hidden p-0">
      <div className="p-4 space-y-3">
        {/* Header: badges */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {isHot && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-gradient-to-r from-[#ff7a3d] to-[#ff5722] text-white shadow-[0_0_14px_-3px_rgba(255,122,61,0.55)]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1.5.5-2.5 1-3.5C9 8 10 10 10 10s-.5-2 0-4 2-4 2-4zm-1 10c1.5 0 2 1 2 2 0 2-2 3-2 5 0 0-3-1-3-4 0-2 2-3 3-3z" />
                </svg>
                HOT
              </span>
            )}
            {outcomes[0] && outcomes[1] && (
              <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-white/[0.04] text-trading-text-dim border border-white/[0.06]">
                {outcomes[0]} / {outcomes[1]}
              </span>
            )}
          </div>
        </div>

        {/* Question + thumbnail */}
        <div className="flex items-start gap-3">
          {market.image && (
            <div className="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-trading-surface-2">
              <img
                src={market.image}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}
          <h3 className="flex-1 text-[14px] font-semibold leading-snug text-trading-text">
            {market.question}
          </h3>
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Voting split */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-left">
              <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">
                Voted <span className="font-bold">YES</span>
              </p>
              <p className="text-[20px] font-bold text-emerald-400 tabular-nums leading-none mt-0.5">{yesPct}%</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-trading-text-dim uppercase tracking-wide">
                Voted <span className="font-bold">NO</span>
              </p>
              <p className="text-[20px] font-bold text-rose-400 tabular-nums leading-none mt-0.5">{noPct}%</p>
            </div>
          </div>

          <div className="relative h-2.5 bg-rose-500/80 rounded-sm overflow-hidden">
            <div
              className="absolute top-0 left-0 h-full bg-emerald-500 transition-all duration-500 ease-out"
              style={{ width: `${yesPct}%` }}
            />
            <div
              className="absolute top-[-25%] h-[150%] w-2 bg-trading-bg"
              style={{ left: `${yesPct}%`, transform: 'translateX(-100%) skewX(-15deg)' }}
            />
          </div>

          <div className="flex items-center justify-between text-[10px] text-trading-text-dim">
            <span>VOL {formatCompact(vol)}</span>
            <span>24H {formatCompact(market.volume24hr ?? 0)}</span>
            <span>LIQ {formatCompact(market.liquidityNum ?? parseFloat(market.liquidity || '0'))}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            onClick={() => onTrade(market, 'BUY_YES')}
            className="group relative overflow-hidden rounded-full py-2.5 text-[12px] font-bold tracking-wide bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-400/30 hover:border-emerald-300/50 transition-all"
          >
            <span className="relative z-10 inline-flex items-center justify-center gap-1">
              BUY YES
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </svg>
            </span>
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-emerald-200/25 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 ease-out" />
          </button>
          <button
            onClick={() => onTrade(market, 'BUY_NO')}
            className="group relative overflow-hidden rounded-full py-2.5 text-[12px] font-bold tracking-wide bg-rose-600 hover:bg-rose-500 text-white border border-rose-400/30 hover:border-rose-300/50 transition-all"
          >
            <span className="relative z-10 inline-flex items-center justify-center gap-1">
              BUY NO
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="7" x2="17" y2="17" />
                <polyline points="17 7 17 17 7 17" />
              </svg>
            </span>
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-rose-200/25 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 ease-out" />
          </button>
        </div>

        <button
          onClick={handleAnalyze}
          disabled={analyzing}
          className={`w-full text-[11px] font-semibold py-1.5 rounded-md border transition-colors ${
            showAnalysis
              ? 'bg-trading-accent/10 text-trading-accent border-trading-accent/30'
              : 'bg-white/[0.02] text-trading-text-dim border-white/[0.06] hover:text-trading-text hover:border-white/[0.12]'
          }`}
        >
          {analyzing ? 'Analyzing…' : showAnalysis ? 'Hide Analysis' : 'Analyze with AI'}
        </button>

        {showAnalysis && <AnalysisPanel analysis={analysis} loading={analyzing} />}
      </div>
    </div>
  );
}

// ─── Arb Section ────────────────────────────────────────────────────────────

function ArbSection({ arb: opportunity }: { arb: ArbOpportunity }) {
  const { kalshi, similarity, arb } = opportunity;
  const simPct = Math.round(similarity * 100);
  const spreadPp = arb.spread * 100;
  const absSpreadPp = Math.abs(spreadPp);
  const roiPct = arb.roi * 100;
  const buyYesVenue = arb.direction.buyYesOn;
  const buyNoVenue = arb.direction.buyNoOn;
  const profitable = arb.profitable;

  const yesVenueLabel = buyYesVenue === 'polymarket' ? 'Polymarket' : 'Kalshi';
  const noVenueLabel = buyNoVenue === 'polymarket' ? 'Polymarket' : 'Kalshi';
  const yesFillPrice = buyYesVenue === 'polymarket' ? arb.polyYes : arb.kalshiYes;
  const noFillPrice = buyNoVenue === 'polymarket' ? 1 - arb.polyYes : 1 - arb.kalshiYes;

  return (
    <div className="mt-3 pt-3 border-t border-trading-border/60 space-y-2.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${
            profitable
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
              : 'bg-white/[0.04] text-trading-text-dim border-white/[0.06]'
          }`}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 17l6-6 4 4 8-8" />
              <path d="M14 7h7v7" />
            </svg>
            {profitable ? 'ARB OPPORTUNITY' : 'CROSS-EXCHANGE'}
          </span>
          <span className="text-[10px] text-trading-text-dim">
            {simPct}% match
          </span>
        </div>
        <span className={`text-[11px] font-mono font-semibold ${absSpreadPp >= 5 ? 'text-emerald-400' : 'text-trading-text-dim'}`}>
          {spreadPp >= 0 ? '+' : ''}{spreadPp.toFixed(1)}pp spread
        </span>
      </div>

      {/* Matched market */}
      <a
        href={kalshi.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-lg bg-trading-bg/60 border border-trading-border/60 hover:border-trading-border-light p-2.5 transition-colors"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#00d09c]/10 text-[#00d09c] border border-[#00d09c]/20">
                Kalshi
              </span>
              <span className="text-[10px] text-trading-text-dim truncate">
                {kalshi.ticker}
              </span>
            </div>
            <p className="text-[11px] text-trading-text-secondary leading-snug line-clamp-2">
              {kalshi.title}
            </p>
            {kalshi.subtitle && (
              <p className="text-[10px] text-trading-text-dim mt-0.5 line-clamp-1">
                {kalshi.subtitle}
              </p>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-[9px] text-trading-text-dim uppercase tracking-wider">YES</div>
            <div className="text-[13px] font-mono font-semibold text-trading-text">
              {kalshi.yesPrice !== null ? `${(kalshi.yesPrice * 100).toFixed(0)}¢` : '—'}
            </div>
          </div>
        </div>
      </a>

      {/* Execution plan */}
      <div className="rounded-lg bg-trading-bg/40 border border-trading-border/60 p-2.5 space-y-1.5">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-trading-text-dim">
          Execution plan · ${arb.deployedUsd.toFixed(2)} deployed
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-md bg-emerald-500/5 border border-emerald-500/15 p-1.5">
            <div className="text-[9px] text-emerald-400/80 uppercase tracking-wider">Buy YES</div>
            <div className="text-trading-text-secondary font-medium">{yesVenueLabel}</div>
            <div className="text-[10px] text-trading-text-dim mono">
              {arb.pairs} × {(yesFillPrice * 100).toFixed(0)}¢
            </div>
          </div>
          <div className="rounded-md bg-rose-500/5 border border-rose-500/15 p-1.5">
            <div className="text-[9px] text-rose-400/80 uppercase tracking-wider">Buy NO</div>
            <div className="text-trading-text-secondary font-medium">{noVenueLabel}</div>
            <div className="text-[10px] text-trading-text-dim mono">
              {arb.pairs} × {(noFillPrice * 100).toFixed(0)}¢
            </div>
          </div>
        </div>
      </div>

      {/* P&L breakdown */}
      <div className="rounded-lg bg-trading-bg/40 border border-trading-border/60 p-2.5 space-y-0.5 text-[11px] font-mono">
        <PLRow label="Gross profit" value={arb.grossProfitUsd} tone="positive" />
        <PLRow label="Polymarket fees" value={-arb.polyFeesUsd} tone="negative" />
        <PLRow label="Kalshi fees" value={-arb.kalshiFeesUsd} tone="negative" />
        <div className="h-px bg-trading-border/80 my-1" />
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-trading-text">Net profit</span>
          <div className="flex items-baseline gap-1.5">
            <span className={`text-[13px] font-semibold ${profitable ? 'text-emerald-400' : 'text-rose-400'}`}>
              {arb.netProfitUsd >= 0 ? '+' : ''}${arb.netProfitUsd.toFixed(2)}
            </span>
            <span className={`text-[10px] ${profitable ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>
              {roiPct >= 0 ? '+' : ''}{roiPct.toFixed(2)}% ROI
            </span>
          </div>
        </div>
      </div>

      {!profitable && (
        <p className="text-[10px] text-trading-text-dim italic leading-relaxed">
          Spread doesn&apos;t clear fees at current depth — wait for wider dislocation before executing.
        </p>
      )}
    </div>
  );
}

function PLRow({ label, value, tone }: { label: string; value: number; tone: 'positive' | 'negative' | 'neutral' }) {
  const color =
    tone === 'positive' ? 'text-emerald-400/90'
    : tone === 'negative' ? 'text-trading-text-dim'
    : 'text-trading-text-secondary';
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-trading-text-dim">{label}</span>
      <span className={color}>
        {value >= 0 ? '+' : ''}${value.toFixed(2)}
      </span>
    </div>
  );
}
