/**
 * Polymarket Gamma API Client
 *
 * Fetches prediction market data from Polymarket's public Gamma API.
 * Endpoints:
 *   - GET /events       — list/filter events (contain markets)
 *   - GET /events?slug= — single event by slug
 *   - GET /markets      — list/filter individual markets
 *   - GET /tags         — available tags/categories
 *
 * Note: Gamma API returns camelCase fields for markets, mixed case for events.
 */

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// ─── Types (match actual Gamma API response shapes) ─────────────────────────

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  description: string;
  endDate: string;
  endDateIso?: string;
  startDate: string;
  active: boolean;
  closed: boolean;
  volume: string;           // string from API
  volumeNum?: number;
  volume24hr?: number;
  liquidity: string;
  liquidityNum?: number;
  outcomes: string;          // JSON-encoded: '["Yes","No"]'
  outcomePrices: string;     // JSON-encoded: '["0.65","0.35"]'
  conditionId: string;
  image: string;
  icon: string;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  clobTokenIds?: string;     // JSON-encoded token IDs
  negRisk?: boolean;         // Whether market uses neg-risk exchange
}

export interface PolymarketEvent {
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
  tags?: { id: string; label: string; slug: string }[];
}

export interface PolymarketTag {
  id: string;
  label: string;
  slug: string;
}

// ─── API Helpers ────────────────────────────────────────────────────────────

async function gammaGet<T>(
  path: string,
  params?: Record<string, string>,
  opts?: { noCache?: boolean },
): Promise<T> {
  const url = new URL(`${GAMMA_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  // Paginated full-corpus scans return 4–5MB pages that blow past Next's
  // 2MB data-cache limit (and spam warnings even when we don't need the
  // cached copy). Let those callers opt out explicitly.
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
    ...(opts?.noCache
      ? { cache: 'no-store' as const }
      : { next: { revalidate: 30 } }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket API error (${res.status}): ${text}`);
  }

  return res.json();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch active events (each contains its associated markets).
 */
export async function getActiveEvents(opts?: {
  limit?: number;
  offset?: number;
  tag_id?: string;
}): Promise<PolymarketEvent[]> {
  const { limit = 20, offset = 0, tag_id } = opts ?? {};

  const events = await gammaGet<PolymarketEvent[]>('/events', {
    active: 'true',
    closed: 'false',
    limit: String(limit),
    offset: String(offset),
    order: 'liquidity',
    ascending: 'false',
    ...(tag_id ? { tag_id } : {}),
  });

  // Filter out any resolved/closed markets within events
  return events
    .map((ev) => ({
      ...ev,
      markets: ev.markets.filter((m) => m.active && !m.closed),
    }))
    .filter((ev) => ev.markets.length > 0);
}

/**
 * Fetch a single event by slug.
 */
export async function getEventBySlug(slug: string): Promise<PolymarketEvent | null> {
  try {
    const data = await gammaGet<PolymarketEvent[]>('/events', { slug });
    return data[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Search markets by text query.
 * Uses Gamma API's _q text search on /markets endpoint (Strapi full-text),
 * plus question_contains as a secondary strategy and client-side filtering fallback.
 */
/**
 * Search active Polymarket markets for a query.
 *
 * Polymarket's Gamma API `_q` / `question_contains` params are completely
 * broken — they ignore the search term and return random popular markets.
 * The only reliable approach is to fetch a large pool of top-liquidity markets
 * and filter locally by keyword matching.
 */
export async function searchMarkets(query: string, limit = 50): Promise<PolymarketMarket[]> {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  // Extract meaningful keywords from the query (drop numbers, price targets, stopwords)
  const keywords = extractKeywords(q);
  if (keywords.length === 0) return [];

  // Crypto ticker expansions: "bitcoin" ↔ "btc", "ethereum" ↔ "eth", etc.
  const CRYPTO_MAP: Record<string, string[]> = {
    bitcoin: ['btc'], btc: ['bitcoin'],
    ethereum: ['eth'], eth: ['ethereum'],
    solana: ['sol'], sol: ['solana'],
    dogecoin: ['doge'], doge: ['dogecoin'],
    ripple: ['xrp'], xrp: ['ripple'],
    // Fed / macro aliases
    fed: ['fomc', 'federal'], fomc: ['fed', 'federal'], federal: ['fed', 'fomc'],
    // US politics
    trump: ['trump'], democrat: ['democratic', 'dem'], republican: ['gop', 'republican'],
  };
  const expandedKeywords = new Set<string>(keywords);
  for (const k of keywords) {
    for (const alias of (CRYPTO_MAP[k] ?? [])) expandedKeywords.add(alias);
  }

  // Fetch a large pool of top-liquidity markets and filter locally.
  // Two parallel pages so we cover ~1000 markets cheaply.
  const [page1, page2] = await Promise.all([
    gammaGet<PolymarketMarket[]>('/markets', {
      active: 'true', closed: 'false',
      limit: '500', offset: '0',
      order: 'liquidity', ascending: 'false',
    }).catch(() => [] as PolymarketMarket[]),
    gammaGet<PolymarketMarket[]>('/markets', {
      active: 'true', closed: 'false',
      limit: '500', offset: '500',
      order: 'liquidity', ascending: 'false',
    }).catch(() => [] as PolymarketMarket[]),
  ]);

  const seen = new Set<string>();
  const matched: PolymarketMarket[] = [];

  for (const m of [...page1, ...page2]) {
    if (!m?.id || seen.has(m.id)) continue;
    if (m.active === false || m.closed === true) continue;
    seen.add(m.id);

    const haystack = `${m.question ?? ''} ${m.slug ?? ''} ${m.description ?? ''}`.toLowerCase();
    for (const kw of expandedKeywords) {
      if (haystack.includes(kw)) {
        matched.push(m);
        break;
      }
    }

    if (matched.length >= limit * 4) break; // enough candidates
  }

  // Sort by liquidity descending
  matched.sort((a, b) => {
    const la = a.liquidityNum ?? parseFloat(a.liquidity || '0');
    const lb = b.liquidityNum ?? parseFloat(b.liquidity || '0');
    return lb - la;
  });

  return matched.slice(0, limit);
}

/** Pull meaningful topic words from a query — strips numbers, price targets, and filler. */
function extractKeywords(query: string): string[] {
  const STRIP = new Set([
    'above', 'below', 'over', 'under', 'reach', 'hit', 'between', 'beyond',
    'will', 'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was',
    'by', 'before', 'after', 'end', 'eoy', 'eom', 'year', 'month',
    'january','february','march','april','may','june','july','august',
    'september','october','november','december',
    'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
    '2024','2025','2026','2027','2028','2029','2030',
  ]);
  return query
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STRIP.has(w) && !/^\d+[km]?$/.test(w));
}

/**
 * Fetch all available tags.
 */
export async function getTags(): Promise<PolymarketTag[]> {
  return gammaGet<PolymarketTag[]>('/tags');
}

/**
 * Fetch top markets (flat list, not grouped by event).
 */
export async function getTopMarkets(opts?: {
  limit?: number;
  offset?: number;
}): Promise<PolymarketMarket[]> {
  const { limit = 20, offset = 0 } = opts ?? {};

  return gammaGet<PolymarketMarket[]>('/markets', {
    active: 'true',
    closed: 'false',
    limit: String(limit),
    offset: String(offset),
    order: 'liquidity',
    ascending: 'false',
  });
}

/**
 * Page through every active Polymarket market, up to `cap`. Polymarket caps
 * each page at 500. We fetch two pages in parallel per batch and stop when
 * a page comes back short (end of feed) or we hit the cap.
 *
 * Results are cached in-process for 5 minutes to avoid re-paginating the
 * full corpus on every arb scan.
 */
const ALL_MARKETS_TTL_MS = 5 * 60_000;
const allMarketsCache = new Map<number, { data: PolymarketMarket[]; at: number }>();

export async function getAllActiveMarkets(cap: number = Infinity): Promise<PolymarketMarket[]> {
  const PAGE = 500;
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? Math.ceil(cap) : 10_000;

  // Return cached result if fresh enough
  const memHit = allMarketsCache.get(effectiveCap);
  if (memHit && Date.now() - memHit.at < ALL_MARKETS_TTL_MS) {
    return memHit.data;
  }

  const out: PolymarketMarket[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (out.length < effectiveCap) {
    const [a, b] = await Promise.all([
      gammaGet<PolymarketMarket[]>('/markets', {
        active: 'true', closed: 'false',
        limit: String(PAGE), offset: String(offset),
        order: 'liquidity', ascending: 'false',
      }, { noCache: true }).catch(() => [] as PolymarketMarket[]),
      gammaGet<PolymarketMarket[]>('/markets', {
        active: 'true', closed: 'false',
        limit: String(PAGE), offset: String(offset + PAGE),
        order: 'liquidity', ascending: 'false',
      }, { noCache: true }).catch(() => [] as PolymarketMarket[]),
    ]);

    let added = 0;
    for (const m of [...a, ...b]) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
      added++;
      if (out.length >= effectiveCap) break;
    }

    // End of feed: neither page filled up.
    if (a.length < PAGE && b.length < PAGE) break;
    if (added === 0) break;

    offset += PAGE * 2;
  }

  allMarketsCache.set(effectiveCap, { data: out, at: Date.now() });
  return out;
}

// ─── LLM Context Helper ────────────────────────────────────────────────────

/**
 * Build a condensed text summary of top markets for LLM context injection.
 */
export async function buildMarketsContextForLLM(limit = 10): Promise<string> {
  const events = await getActiveEvents({ limit });

  const lines = events.map((ev, i) => {
    const marketSummaries = ev.markets
      .slice(0, 5) // cap per event to save tokens
      .map((m) => {
        const prices = safeParseJsonArray(m.outcomePrices);
        const outcomes = safeParseJsonArray(m.outcomes);
        const pairs = outcomes.map((o: string, j: number) =>
          `${o}: ${(parseFloat(prices[j] ?? '0') * 100).toFixed(0)}%`
        );
        const vol = m.volume24hr ?? parseFloat(m.volume || '0');
        const tokenIds = parseClobTokenIds(m);
        const tokenInfo = tokenIds ? ` tokenIds=[${tokenIds.yes},${tokenIds.no}]` : '';
        return `  - "${m.question}" [${pairs.join(' / ')}] vol=${formatCompact(vol)}${tokenInfo}`;
      })
      .join('\n');

    return `${i + 1}. ${ev.title} (slug: ${ev.slug})\n${marketSummaries}`;
  });

  return `Active Polymarket prediction markets:\n${lines.join('\n\n')}`;
}

// ─── CLOB Token ID Helpers ───────────────────────────────────────────────────

/**
 * Parse clobTokenIds from a market into { yes, no } token IDs.
 * clobTokenIds is a JSON-encoded array: '["yesTokenId","noTokenId"]'
 */
/**
 * Derive a preview price from the market's public Gamma fields without hitting
 * CLOB (which is geo-blocked on many server regions).
 *
 * Priority:
 *   1. bestAsk / bestBid (live orderbook edges from Gamma)
 *   2. outcomePrices[i] (last trade / mid)
 *
 * For binary YES/NO markets, the NO token's ask = 1 - YES.bestBid and
 * the NO token's bid = 1 - YES.bestAsk. That's what this helper encodes.
 */
export function getPriceFromMarket(
  market: PolymarketMarket,
  action: 'BUY_YES' | 'SELL_YES' | 'BUY_NO' | 'SELL_NO',
): number | null {
  const yesBid = typeof market.bestBid === 'number' ? market.bestBid : null;
  const yesAsk = typeof market.bestAsk === 'number' ? market.bestAsk : null;

  let outcomeMid: number | null = null;
  try {
    const prices = JSON.parse(market.outcomePrices || '[]') as string[];
    const yes = parseFloat(prices[0] ?? 'NaN');
    const no = parseFloat(prices[1] ?? 'NaN');
    if (action === 'BUY_YES' || action === 'SELL_YES') {
      outcomeMid = Number.isFinite(yes) ? yes : null;
    } else {
      outcomeMid = Number.isFinite(no) ? no : null;
    }
  } catch { /* ignore */ }

  let p: number | null = null;
  switch (action) {
    case 'BUY_YES':  p = yesAsk ?? outcomeMid; break;
    case 'SELL_YES': p = yesBid ?? outcomeMid; break;
    case 'BUY_NO':   p = (yesBid !== null ? 1 - yesBid : null) ?? outcomeMid; break;
    case 'SELL_NO':  p = (yesAsk !== null ? 1 - yesAsk : null) ?? outcomeMid; break;
  }

  // Sanity bounds — Polymarket prices are 0..1; reject 0 (no quote) and >=1
  if (p === null || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return p;
}

export function parseClobTokenIds(market: PolymarketMarket): { yes: string; no: string } | null {
  const ids = safeParseJsonArray(market.clobTokenIds);
  if (ids.length < 2) return null;
  return { yes: ids[0], no: ids[1] };
}

/**
 * Fetch a single market by condition ID from Gamma API.
 */
export async function getMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null> {
  try {
    const markets = await gammaGet<PolymarketMarket[]>('/markets', { condition_id: conditionId });
    return markets[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single market by slug from Gamma API.
 */
export async function getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  try {
    const markets = await gammaGet<PolymarketMarket[]>('/markets', { slug });
    return markets[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function safeParseJsonArray(str: string | undefined): string[] {
  if (!str) return [];
  try {
    return JSON.parse(str);
  } catch {
    return [];
  }
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
