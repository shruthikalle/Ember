/**
 * Cross-exchange arbitrage helpers for Polymarket ↔ Kalshi.
 *
 * Two things:
 *   1. `findBestKalshiMatch(poly)` — given a Polymarket market, returns its
 *      best Kalshi counterpart by semantic similarity (uses the persistent
 *      embedding cache, so repeat calls are effectively free).
 *   2. `computeArb(polyYes, kalshiYes, ...)` — given both YES prices, works
 *      out direction, sizing, gross/net P&L, and ROI after fees.
 *
 * Only liquid, actively-traded Kalshi markets are considered — markets with
 * zero open interest and zero 24h volume are filtered out, matching what the
 * cross-exchange scanner uses.
 */

import {
  getKalshiMarkets,
  kalshiIsQuoted,
  kalshiLiquidity,
  kalshiMarketUrl,
  kalshiVolume24h,
  kalshiYesPrice,
  type KalshiMarket,
} from '@/src/lib/kalshi';
import type { PolymarketMarket } from '@/src/lib/polymarket';
import { embedTexts } from '@/src/lib/embeddings';
import {
  getNormalizedIndex,
  normalizeCopy,
  argmaxSimilarity,
} from '@/src/lib/predictions/embeddingIndex';
import { boundaryPrefilter, checkEquivalence } from '@/src/lib/predictions/equivalence';

const KALSHI_POOL = 10_000;
const DEFAULT_MIN_SIMILARITY = 0.55;

// Fee assumptions — conservative estimates. Adjust once we see real fills.
const POLY_TAKER_FEE_RATE = 0.004; // 0.4%
// Kalshi's variable fee: 0.07 × contracts × p × (1 − p), where p is fill price.
const KALSHI_FEE_COEFF = 0.07;

function polymarketToText(m: PolymarketMarket): string {
  const desc = (m.description || '').replace(/\s+/g, ' ').trim();
  return [m.question, desc].filter(Boolean).join(' — ').slice(0, 600);
}

function kalshiToText(m: KalshiMarket): string {
  const rules = (m.rules_primary || '').replace(/\s+/g, ' ').trim();
  const parts = [m.event_title, m.title, m.yes_sub_title, m.subtitle, rules].filter(
    (v, i, arr) => !!v && arr.indexOf(v) === i,
  );
  return parts.join(' — ').slice(0, 600);
}

/** A single match + its similarity score. */
export interface KalshiMatch {
  market: KalshiMarket;
  similarity: number;
}

/**
 * Load the live Kalshi corpus and return the shared normalized-embedding
 * index. The index is memoized per process by the ticker fingerprint so
 * back-to-back arb scans skip the 10k-vector renormalize + SQLite reload.
 */
async function getKalshiIndex() {
  const kalshiAll = await getKalshiMarkets({ limit: KALSHI_POOL, status: 'open' });
  const kalshi = kalshiAll.filter((m) => {
    if (m.status !== 'active' || !m.title) return false;
    if (!kalshiIsQuoted(m)) return false;
    const oi = Number(m.open_interest_fp) || 0;
    const v24 = Number(m.volume_24h_fp) || 0;
    return oi > 0 || v24 > 0;
  });
  return getNormalizedIndex('kalshi', kalshi, (m) => m.ticker, kalshiToText);
}

/**
 * Find the highest-similarity Kalshi market for a given Polymarket market.
 * Returns null if nothing clears `minSimilarity` (default 0.55).
 *
 * Hot path: the Kalshi matrix is cached per process, so only the Polymarket
 * query vector is freshly embedded (normally a memo/SQLite hit) and the
 * similarity scan is a single contiguous-memory sweep.
 */
export async function findBestKalshiMatch(
  poly: PolymarketMarket,
  opts?: { minSimilarity?: number },
): Promise<KalshiMatch | null> {
  const threshold = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const index = await getKalshiIndex();
  if (index.entries.length === 0) return null;

  const [polyEmbRaw] = await embedTexts([polymarketToText(poly)]);
  const pe = normalizeCopy(polyEmbRaw);

  const { idx, sim } = argmaxSimilarity(pe, index.matrix, index.dim, index.entries.length);
  if (idx < 0 || sim < threshold) return null;
  return { market: index.entries[idx], similarity: sim };
}

export interface ArbCalculation {
  /** Polymarket YES price (0..1). */
  polyYes: number;
  /** Kalshi YES price (0..1). */
  kalshiYes: number;
  /** Signed spread: positive ⇒ Polymarket YES is more expensive. */
  spread: number;
  /** Direction of the two legs to form a locked payout. */
  direction: {
    buyYesOn: 'polymarket' | 'kalshi';
    buyNoOn: 'polymarket' | 'kalshi';
  };
  /** Cost of a single 1-contract-each pair before fees. */
  costPerPair: number;
  /** $1 − costPerPair, gross margin per pair at settlement. */
  grossPerPair: number;
  /** Number of matched pairs we can size given `maxNotionalUsd`. */
  pairs: number;
  /** Dollars actually deployed (pairs × costPerPair). */
  deployedUsd: number;
  /** Gross payout minus cost (before fees). */
  grossProfitUsd: number;
  /** Estimated Polymarket taker fee. */
  polyFeesUsd: number;
  /** Estimated Kalshi variable fee. */
  kalshiFeesUsd: number;
  /** Net profit after fees. */
  netProfitUsd: number;
  /** Return on deployed capital (net / deployed). */
  roi: number;
  /** Whether net P&L is positive after fees. */
  profitable: boolean;
}

/**
 * Given both venues' YES prices, compute the arbitrage direction and
 * estimated P&L for a bounded notional. Returns null if the spread is below
 * the minimum actionable threshold (5bp).
 */
export function computeArb(
  polyYes: number,
  kalshiYes: number,
  maxNotionalUsd = 100,
): ArbCalculation | null {
  if (!(polyYes > 0 && polyYes < 1 && kalshiYes > 0 && kalshiYes < 1)) return null;

  const spread = polyYes - kalshiYes;
  if (Math.abs(spread) < 0.005) return null;

  // Buy YES on the cheaper side, buy NO (= sell YES) on the expensive side.
  const polyExpensive = spread > 0;
  const direction: ArbCalculation['direction'] = {
    buyYesOn: polyExpensive ? 'kalshi' : 'polymarket',
    buyNoOn: polyExpensive ? 'polymarket' : 'kalshi',
  };

  const yesPrice = Math.min(polyYes, kalshiYes);      // paid on cheap-YES leg
  const noPrice = 1 - Math.max(polyYes, kalshiYes);   // paid on cheap-NO leg
  const costPerPair = yesPrice + noPrice;
  const grossPerPair = 1 - costPerPair;

  const pairs = Math.floor(maxNotionalUsd / costPerPair);
  if (pairs <= 0) return null;

  const deployedUsd = pairs * costPerPair;
  const grossProfitUsd = pairs * grossPerPair;

  // Polymarket taker fee: % of the Poly leg's fill notional.
  const polyLegPrice = polyExpensive ? 1 - polyYes : polyYes;
  const polyFeesUsd = pairs * polyLegPrice * POLY_TAKER_FEE_RATE;

  // Kalshi variable fee: 0.07 × p × (1 − p) per contract, where p is fill price
  // on the Kalshi leg. At mid-range prices this is the dominant fee.
  const kalshiLegPrice = polyExpensive ? kalshiYes : 1 - kalshiYes;
  const kalshiPerContract = KALSHI_FEE_COEFF * kalshiLegPrice * (1 - kalshiLegPrice);
  const kalshiFeesUsd = pairs * kalshiPerContract;

  const netProfitUsd = grossProfitUsd - polyFeesUsd - kalshiFeesUsd;
  const roi = deployedUsd > 0 ? netProfitUsd / deployedUsd : 0;

  return {
    polyYes: +polyYes.toFixed(4),
    kalshiYes: +kalshiYes.toFixed(4),
    spread: +spread.toFixed(4),
    direction,
    costPerPair: +costPerPair.toFixed(4),
    grossPerPair: +grossPerPair.toFixed(4),
    pairs,
    deployedUsd: +deployedUsd.toFixed(2),
    grossProfitUsd: +grossProfitUsd.toFixed(2),
    polyFeesUsd: +polyFeesUsd.toFixed(2),
    kalshiFeesUsd: +kalshiFeesUsd.toFixed(2),
    netProfitUsd: +netProfitUsd.toFixed(2),
    roi: +roi.toFixed(4),
    profitable: netProfitUsd > 0,
  };
}

/** Compact shape we pass to the frontend inside the analyze response. */
export interface ArbOpportunity {
  kalshi: {
    ticker: string;
    eventTicker: string;
    seriesTicker?: string;
    title: string;
    subtitle: string | null;
    yesPrice: number | null;
    volume24h: number;
    liquidity: number;
    url: string;
  };
  similarity: number;
  arb: ArbCalculation;
}

// Full arb-opportunity result gets cached by Polymarket slug + current YES
// price. The price is part of the key so a meaningful book move busts the
// cache automatically; within that window we skip the 10k-market similarity
// scan entirely. TTL is short because prices move.
// Key already includes Polymarket YES price rounded to 0.1¢, so any real
// price move invalidates the cache on its own — that's our freshness guard.
// TTL just caps how long a quiet book keeps a cached result (and, crucially,
// how long results survive a `next dev` restart). 15 min is enough that the
// user sees the arb panel populated instantly when they come back.
const ARB_TTL_MS = 15 * 60_000;
const arbMemoryCache = new Map<string, { data: ArbOpportunity | null; at: number }>();

function arbCacheKey(poly: PolymarketMarket): string {
  // Round price to 3 decimals (≈0.1¢) so tiny ticks don't blow the cache but
  // real moves still do.
  let polyYes = '';
  try {
    const prices = JSON.parse(poly.outcomePrices || '[]') as string[];
    const y = parseFloat(prices[0] ?? 'NaN');
    if (Number.isFinite(y)) polyYes = y.toFixed(3);
  } catch { /* ignore */ }
  return `arb:${poly.slug || poly.id}:${polyYes}`;
}

/**
 * End-to-end: find the best Kalshi match for a Polymarket market, pull its
 * YES price, compute arb economics, and return a single opportunity payload.
 * Returns null if there's no similar market or no actionable spread.
 */
export async function buildArbOpportunity(
  poly: PolymarketMarket,
  opts?: { minSimilarity?: number; maxNotionalUsd?: number },
): Promise<ArbOpportunity | null> {
  const cacheKey = arbCacheKey(poly);

  const memHit = arbMemoryCache.get(cacheKey);
  if (memHit && Date.now() - memHit.at < ARB_TTL_MS) {
    return memHit.data;
  }

  // Disk cache — survives `next dev` restarts. We cache the negative result
  // (`null`) too so we don't re-run the full embed sweep just to re-discover
  // there's no match.
  try {
    const { getSimilarCache } = await import('@/src/lib/db');
    const diskHit = getSimilarCache(cacheKey, ARB_TTL_MS) as
      | { value: ArbOpportunity | null }
      | null;
    if (diskHit && typeof diskHit === 'object' && 'value' in diskHit) {
      arbMemoryCache.set(cacheKey, { data: diskHit.value, at: Date.now() });
      return diskHit.value;
    }
  } catch { /* fall through */ }

  const result = await buildArbOpportunityUncached(poly, opts);

  arbMemoryCache.set(cacheKey, { data: result, at: Date.now() });
  try {
    const { putSimilarCache } = await import('@/src/lib/db');
    putSimilarCache(cacheKey, { value: result });
  } catch { /* non-fatal */ }

  return result;
}

// Long-TTL cache for the Polymarket→Kalshi MATCH only. The match doesn't
// depend on price — it's a purely semantic lookup — so we don't want it to
// invalidate every time polyYes ticks by 0.1¢. Storing only the ticker +
// similarity keeps rows tiny and lets us re-lookup the live Kalshi market
// (with current quotes) from the in-process index.
const MATCH_TTL_MS = 30 * 60_000;

async function resolveKalshiMatch(
  poly: PolymarketMarket,
  opts?: { minSimilarity?: number },
): Promise<KalshiMatch | null> {
  const threshold = opts?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const polyKey = poly.slug || poly.id;
  const index = await getKalshiIndex();
  if (index.entries.length === 0) return null;

  // Try the persistent match cache first — one indexed SQLite read, skips
  // the entire similarity scan when hit.
  try {
    const { getMatchCache } = await import('@/src/lib/db');
    const hit = getMatchCache(polyKey, index.version, MATCH_TTL_MS);
    if (hit && hit.similarity >= threshold) {
      const mkt = index.entries.find((m) => m.ticker === hit.bestTicker);
      if (mkt) return { market: mkt, similarity: hit.similarity };
      // Ticker vanished from the live corpus — fall through to re-scan.
    }
  } catch { /* fall through */ }

  const match = await findBestKalshiMatch(poly, opts);
  if (match) {
    try {
      const { putMatchCache } = await import('@/src/lib/db');
      putMatchCache(polyKey, index.version, match.market.ticker, match.similarity);
    } catch { /* non-fatal */ }
  }
  return match;
}

async function buildArbOpportunityUncached(
  poly: PolymarketMarket,
  opts?: { minSimilarity?: number; maxNotionalUsd?: number },
): Promise<ArbOpportunity | null> {
  const match = await resolveKalshiMatch(poly, { minSimilarity: opts?.minSimilarity });
  if (!match) return null;

  const kalshiPrice = kalshiYesPrice(match.market);
  if (kalshiPrice === null) return null;

  let polyYes: number | null = null;
  try {
    const prices = JSON.parse(poly.outcomePrices || '[]') as string[];
    const y = parseFloat(prices[0] ?? 'NaN');
    if (Number.isFinite(y)) polyYes = y;
  } catch { /* ignore */ }
  if (polyYes === null) return null;

  const arb = computeArb(polyYes, kalshiPrice, opts?.maxNotionalUsd ?? 100);
  if (!arb) return null;

  // Gate: semantic similarity is too permissive for arb math. A matched pair
  // that sounds alike but resolves on different events ("Bailey wins ROY"
  // vs "any top-5 pick wins ROY") would otherwise surface here as a
  // profitable arb. Run the cheap regex boundary prefilter first, then the
  // cached Haiku equivalence check.
  const polyText = poly.question;
  const kalshiText = [match.market.event_title || match.market.title, match.market.yes_sub_title || match.market.subtitle]
    .filter(Boolean)
    .join(' — ');

  if (boundaryPrefilter(polyText, kalshiText).reject) return null;
  const eq = await checkEquivalence(polyText, kalshiText);
  if (!eq.equivalent) return null;

  return {
    kalshi: {
      ticker: match.market.ticker,
      eventTicker: match.market.event_ticker,
      seriesTicker: match.market.series_ticker,
      title: match.market.event_title || match.market.title,
      subtitle: match.market.yes_sub_title || match.market.subtitle || null,
      yesPrice: kalshiPrice,
      volume24h: kalshiVolume24h(match.market),
      liquidity: kalshiLiquidity(match.market),
      url: kalshiMarketUrl(match.market),
    },
    similarity: +match.similarity.toFixed(4),
    arb,
  };
}
