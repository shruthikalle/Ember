/**
 * Kalshi API Client (public market data)
 *
 * Docs: https://docs.kalshi.com/typescript-sdk/api/MarketsApi
 * Base: https://api.elections.kalshi.com/trade-api/v2
 *
 * We use `/events?with_nested_markets=true&status=open` rather than the flat
 * `/markets` listing. The flat listing currently surfaces mostly multi-leg
 * sports parlays (with `custom_strike` / `mve_collection_ticker`) that don't
 * embed meaningfully; events give us the clean prediction-market catalog:
 * elections, geopolitics, climate, crypto milestones, etc.
 *
 * Price/volume fields are the current Kalshi schema:
 *   - yes_bid_dollars / yes_ask_dollars / last_price_dollars  (decimal 0..1)
 *   - volume_fp / volume_24h_fp / open_interest_fp            (numeric)
 *   - liquidity_dollars / notional_value_dollars              (decimal dollars)
 */

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  status: 'active' | 'closed' | 'settled' | 'finalized' | 'determined' | 'initialized';

  // Current Kalshi schema (decimal dollars, already in 0..1 probability space)
  yes_bid_dollars?: number | string | null;
  yes_ask_dollars?: number | string | null;
  no_bid_dollars?: number | string | null;
  no_ask_dollars?: number | string | null;
  last_price_dollars?: number | string | null;

  volume_fp?: number | null;
  volume_24h_fp?: number | null;
  open_interest_fp?: number | null;
  liquidity_dollars?: number | string | null;
  notional_value_dollars?: number | string | null;

  category?: string;
  rules_primary?: string;
  rules_secondary?: string;

  // Composite/parlay markers — we skip these for similarity matching.
  custom_strike?: unknown;
  mve_collection_ticker?: string;

  // Enriched by our client so embeddings + UI see the parent event.
  event_title?: string;
  series_ticker?: string;
}

interface KalshiEvent {
  event_ticker: string;
  series_ticker?: string;
  title: string;
  sub_title?: string;
  category?: string;
  status?: string;
  markets?: KalshiMarket[];
}

interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}

async function kalshiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${KALSHI_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi API error (${res.status}): ${text}`);
  }

  return res.json();
}

function toNum(x: number | string | null | undefined): number {
  if (x === null || x === undefined) return 0;
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch open Kalshi markets via the events endpoint. Follows the cursor until
 * `limit` markets are accumulated. Each returned market is annotated with its
 * parent event's title in `event_title` so callers can build richer text for
 * embeddings.
 */
// Persistent disk cache for the full market list — one fetch pulls 50+ pages
// and ~1MB of JSON, so even a short TTL saves an enormous amount of work and
// (critically) survives `next dev` restarts.
// Kalshi's event universe doesn't churn fast — new markets trickle in over
// hours/days, and individual prices only matter once we pick a match. 30 min
// keeps the list fresh enough while letting dev restarts reuse the cached
// 10k-market dump (otherwise the first arb scan after a restart pays ~50
// paginated HTTP round trips).
const KALSHI_MARKETS_TTL_MS = 30 * 60_000;
const kalshiMemoryCache = new Map<string, { data: KalshiMarket[]; at: number }>();

export async function getKalshiMarkets(opts?: {
  limit?: number;
  status?: 'open' | 'closed' | 'settled';
}): Promise<KalshiMarket[]> {
  const target = opts?.limit ?? 200;
  const status = opts?.status ?? 'open';
  const cacheKey = `kalshi:markets:${status}:${target}`;

  // Layer 1 — in-process memo (covers the same-request duplicate calls from
  // embedTexts batching without touching disk).
  const memHit = kalshiMemoryCache.get(cacheKey);
  if (memHit && Date.now() - memHit.at < KALSHI_MARKETS_TTL_MS) {
    return memHit.data;
  }

  // Layer 2 — SQLite-backed disk cache (survives process restarts). Imported
  // lazily so this file stays usable in edge/runtime contexts that don't
  // bundle better-sqlite3.
  try {
    const { getSimilarCache } = await import('./db');
    const diskHit = getSimilarCache(cacheKey, KALSHI_MARKETS_TTL_MS) as
      | KalshiMarket[]
      | null;
    if (diskHit && Array.isArray(diskHit) && diskHit.length > 0) {
      kalshiMemoryCache.set(cacheKey, { data: diskHit, at: Date.now() });
      return diskHit;
    }
  } catch { /* cache unavailable — fall through to live fetch */ }

  const out: KalshiMarket[] = [];
  let cursor: string | undefined;

  while (out.length < target) {
    const page: KalshiEventsResponse = await kalshiGet('/events', {
      limit: '200',
      status,
      with_nested_markets: 'true',
      ...(cursor ? { cursor } : {}),
    });

    if (!page.events?.length) break;

    for (const ev of page.events) {
      for (const m of ev.markets ?? []) {
        // Skip multi-leg parlays and composite sports markets.
        if (m.custom_strike || m.mve_collection_ticker) continue;
        out.push({
          ...m,
          event_title: ev.title,
          series_ticker: ev.series_ticker,
        });
        if (out.length >= target) break;
      }
      if (out.length >= target) break;
    }

    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }

  // Persist for next call (and next dev restart).
  kalshiMemoryCache.set(cacheKey, { data: out, at: Date.now() });
  try {
    const { putSimilarCache } = await import('./db');
    putSimilarCache(cacheKey, out);
  } catch { /* non-fatal */ }

  return out;
}

/** Return the YES price as a 0..1 probability. Returns null if unquoted. */
export function kalshiYesPrice(m: KalshiMarket): number | null {
  const last = toNum(m.last_price_dollars);
  if (last > 0 && last < 1) return last;
  const bid = toNum(m.yes_bid_dollars);
  const ask = toNum(m.yes_ask_dollars);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (ask > 0) return ask;
  if (bid > 0) return bid;
  return null;
}

/**
 * 24h dollar volume. `volume_24h_fp` is a *contract count*, not dollars, so
 * we approximate the dollars traded by multiplying by the last trade price
 * (each contract pays up to $1 at settlement). Falls back to the mid of the
 * current quote if there's no last-price print.
 */
export function kalshiVolume24h(m: KalshiMarket): number {
  const contracts = toNum(m.volume_24h_fp);
  if (contracts === 0) return 0;

  const last = toNum(m.last_price_dollars);
  if (last > 0) return contracts * last;

  const bid = toNum(m.yes_bid_dollars);
  const ask = toNum(m.yes_ask_dollars);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask || bid);
  return mid > 0 ? contracts * mid : contracts * 0.5;
}

/**
 * Dollar "liquidity" for Kalshi. The API's `liquidity_dollars` has been
 * returning 0 for every market, so we fall back to open interest × $1 notional
 * — i.e., dollars currently tied up in the market, which is the closest
 * apples-to-apples comparison with Polymarket's reported liquidity.
 */
export function kalshiLiquidity(m: KalshiMarket): number {
  const reported = toNum(m.liquidity_dollars);
  if (reported > 0) return reported;
  return toNum(m.open_interest_fp);
}

/** True when the market has a real two-sided quote. */
export function kalshiIsQuoted(m: KalshiMarket): boolean {
  return toNum(m.yes_ask_dollars) > 0 || toNum(m.yes_bid_dollars) > 0 || toNum(m.last_price_dollars) > 0;
}

/**
 * Build a URL to the Kalshi market page.
 *
 * Kalshi's canonical frontend route is `/markets/{series_slug}/{event_slug}`,
 * where `series_slug` = `series_ticker` lowercased and `event_slug` =
 * `event_ticker` lowercased. The API doesn't return a separate human-readable
 * slug, so we rely on the ticker form, which the frontend canonicalizes.
 */
export function kalshiMarketUrl(m: KalshiMarket): string {
  const series = (m.series_ticker || m.event_ticker.split('-')[0]).toLowerCase();
  const event = m.event_ticker.toLowerCase();
  return `https://kalshi.com/markets/${series}/${event}`;
}
