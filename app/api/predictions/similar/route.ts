/**
 * GET /api/predictions/similar
 *
 * Finds semantically similar markets across Polymarket ↔ Kalshi using
 * OpenAI embeddings + cosine similarity, with two layers of caching:
 *
 *   1. SQLite-backed embedding cache (permanent, keyed by sha1(text)).
 *      First scan embeds everything; re-runs hit disk for known texts and
 *      only embed genuinely new markets.
 *   2. SQLite-backed pairs cache (TTL ~2 min, keyed by request params). Skips
 *      the full fetch + match pipeline for repeat requests within the window.
 *
 * Query params:
 *   - limit      (default 50, max 200)  — number of pairs returned
 *   - minScore   (default 0.40)          — similarity threshold (0..1)
 *   - polyCap    (default 0 = uncapped)  — limit Polymarket pool for speed
 *   - kalshiCap  (default 2000)          — Kalshi pool cap
 *   - refresh    ("1" to bypass the pairs cache)
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getAllActiveMarkets, type PolymarketMarket } from '@/src/lib/polymarket';
import {
  getKalshiMarkets,
  kalshiIsQuoted,
  kalshiLiquidity,
  kalshiMarketUrl,
  kalshiVolume24h,
  kalshiYesPrice,
  type KalshiMarket,
} from '@/src/lib/kalshi';
import { getNormalizedIndex, argmaxSimilarity } from '@/src/lib/predictions/embeddingIndex';
import {
  getSimilarCache,
  putSimilarCache,
  getMatchCacheBatch,
  putMatchCacheBatch,
} from '@/src/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 120;

const PAIRS_TTL_MS = 2 * 60 * 1000;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = clamp(parseInt(params.get('limit') || '50', 10), 1, 200);
  const minScore = clamp(parseFloat(params.get('minScore') || '0.40'), 0, 1);
  const polyCap = Math.max(parseInt(params.get('polyCap') || '0', 10), 0);
  const kalshiCap = clamp(parseInt(params.get('kalshiCap') || '2000', 10), 1, 20000);
  const refresh = params.get('refresh') === '1';

  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ limit, minScore, polyCap, kalshiCap }))
    .digest('hex');

  if (!refresh) {
    const cached = getSimilarCache(cacheKey, PAIRS_TTL_MS);
    if (cached) return NextResponse.json({ ...cached, cached: true });
  }

  try {
    const t0 = Date.now();
    const [polyRaw, kalshiRaw] = await Promise.all([
      // polyCap=0 means "every active market" — paginate until the Gamma
      // feed runs dry. With match_cache, the first scan pays the full NxM
      // cost; subsequent scans against the same corpus are effectively free.
      getAllActiveMarkets(polyCap > 0 ? polyCap : Infinity),
      getKalshiMarkets({ limit: kalshiCap, status: 'open' }),
    ]);
    const tFetch = Date.now() - t0;

    const poly = polyRaw.filter((m) => m.active && !m.closed && !!m.question);
    // Drop Kalshi's long tail: no quotes OR zero trading activity (OI + 24h
    // volume both zero). This keeps all live markets — roughly 2,300 — and
    // cuts ~60% dormant noise.
    const kalshi = kalshiRaw.filter((m) => {
      if (m.status !== 'active' || !m.title) return false;
      if (!kalshiIsQuoted(m)) return false;
      const oi = Number(m.open_interest_fp) || 0;
      const v24 = Number(m.volume_24h_fp) || 0;
      return oi > 0 || v24 > 0;
    });

    if (poly.length === 0 || kalshi.length === 0) {
      const empty = { pairs: [], polyCount: poly.length, kalshiCount: kalshi.length };
      putSimilarCache(cacheKey, empty);
      return NextResponse.json({ ...empty, cached: false });
    }

    // Use the shared normalized-embedding index: one contiguous N×D matrix
    // per corpus, memoized by ticker fingerprint so repeat scans reuse the
    // packed bytes instead of reallocating 15k Float32Arrays.
    const tE0 = Date.now();
    const [polyIndex, kalshiIndex] = await Promise.all([
      getNormalizedIndex('polymarket', poly, (m) => m.id || m.slug || m.question, polymarketToText),
      getNormalizedIndex('kalshi', kalshi, (m) => m.ticker, kalshiToText),
    ]);
    const tEmbed = Date.now() - tE0;

    // Per-poly match cache — if we've already found this market's best
    // Kalshi counterpart against the *same* corpus version, reuse it. For
    // 5k polys against 7k kalshi this saves ~76s of dot-product work on
    // warm runs. The cache version tracks the Kalshi corpus fingerprint,
    // so a shifted universe auto-invalidates.
    const MATCH_CACHE_TTL_MS = 30 * 60_000;
    const polyKeys = polyIndex.entries.map((m) => m.id || m.slug || m.question);
    const kalshiByTicker = new Map<string, { km: KalshiMarket; idx: number }>();
    for (let j = 0; j < kalshiIndex.entries.length; j++) {
      kalshiByTicker.set(kalshiIndex.entries[j].ticker, { km: kalshiIndex.entries[j], idx: j });
    }
    const cached = getMatchCacheBatch(polyKeys, kalshiIndex.version, MATCH_CACHE_TTL_MS);

    const tM0 = Date.now();
    const rawPairs: { pm: PolymarketMarket; km: KalshiMarket; similarity: number }[] = [];
    const pDim = polyIndex.dim;
    const kN = kalshiIndex.entries.length;
    const pe = new Float32Array(pDim);
    const toPersist: { polyKey: string; corpusVersion: string; bestTicker: string; similarity: number }[] = [];
    let cacheHits = 0;
    for (let i = 0; i < polyIndex.entries.length; i++) {
      const polyKey = polyKeys[i];
      const hit = cached.get(polyKey);
      if (hit) {
        cacheHits++;
        const km = kalshiByTicker.get(hit.bestTicker)?.km;
        if (km && hit.similarity >= minScore) {
          rawPairs.push({ pm: polyIndex.entries[i], km, similarity: hit.similarity });
        }
        continue;
      }
      const base = i * pDim;
      for (let k = 0; k < pDim; k++) pe[k] = polyIndex.matrix[base + k];
      const { idx, sim } = argmaxSimilarity(pe, kalshiIndex.matrix, kalshiIndex.dim, kN);
      if (idx >= 0) {
        toPersist.push({
          polyKey,
          corpusVersion: kalshiIndex.version,
          bestTicker: kalshiIndex.entries[idx].ticker,
          similarity: sim,
        });
        if (sim >= minScore) {
          rawPairs.push({ pm: polyIndex.entries[i], km: kalshiIndex.entries[idx], similarity: sim });
        }
      }
    }
    const tMatch = Date.now() - tM0;
    // Persist freshly-computed matches so the next call is instant. Write
    // in one transaction — N inserts share a single fsync.
    if (toPersist.length > 0) {
      try { putMatchCacheBatch(toPersist); } catch { /* non-fatal */ }
    }

    // Compose a ranking score that blends similarity with tradeability
    // signals. Similarity stays as the floor (enforced via minScore above) so
    // dissimilar pairs never rank high, but among matched pairs the top of
    // the list is dominated by wide spreads on liquid, actively-traded
    // markets — the things actually worth trading.
    const scored = rawPairs
      .map(({ pm, km, similarity }) => {
        const p = serializePoly(pm);
        const k = serializeKalshi(km);
        const spread =
          p.yesPrice !== null && k.yesPrice !== null
            ? +(p.yesPrice - k.yesPrice).toFixed(4)
            : null;

        const spreadAbs = spread !== null ? Math.abs(spread) : 0;
        // Use min() so the bottleneck side governs (arb needs both sides liquid).
        const minVol = Math.min(p.volume24h || 0, k.volume24h || 0);
        const minLiq = Math.min(p.liquidity || 0, k.liquidity || 0);

        // Normalize each signal into a 0..1 band.
        const simN = similarity;                            // already 0..1
        const spreadN = Math.min(spreadAbs / 0.20, 1);      // 20pp = full credit
        const volN = Math.log1p(minVol) / Math.log1p(100_000);   // $100K vol ≈ 1
        const liqN = Math.log1p(minLiq) / Math.log1p(500_000);   // $500K liq ≈ 1

        const score =
          0.35 * simN +
          0.35 * spreadN +
          0.20 * Math.min(volN, 1) +
          0.10 * Math.min(liqN, 1);

        return { p, k, spread, similarity, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const pairs = scored.map(({ p, k, spread, similarity, score }) => ({
      similarity: +similarity.toFixed(4),
      score: +score.toFixed(4),
      spread,
      polymarket: p,
      kalshi: k,
    }));

    const payload = {
      pairs,
      polyCount: poly.length,
      kalshiCount: kalshi.length,
      timings: { fetch_ms: tFetch, embed_ms: tEmbed, match_ms: tMatch },
      matchCache: { hits: cacheHits, misses: polyIndex.entries.length - cacheHits, corpusVersion: kalshiIndex.version },
    };
    putSimilarCache(cacheKey, payload);

    return NextResponse.json({ ...payload, cached: false });
  } catch (err) {
    console.error('[Similar Markets API]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to match markets' },
      { status: 500 },
    );
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

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

function serializePoly(m: PolymarketMarket) {
  let yesPrice: number | null = null;
  try {
    const prices = JSON.parse(m.outcomePrices || '[]') as string[];
    const y = parseFloat(prices[0] ?? 'NaN');
    if (Number.isFinite(y)) yesPrice = y;
  } catch { /* ignore */ }

  return {
    id: m.id,
    question: m.question,
    slug: m.slug,
    image: m.image || null,
    yesPrice,
    volume24h: m.volume24hr ?? 0,
    liquidity: m.liquidityNum ?? parseFloat(m.liquidity || '0'),
    url: `https://polymarket.com/market/${m.slug}`,
  };
}

function serializeKalshi(m: KalshiMarket) {
  return {
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    title: m.event_title || m.title,
    subtitle: m.yes_sub_title || m.subtitle || null,
    yesPrice: kalshiYesPrice(m),
    volume24h: kalshiVolume24h(m),
    liquidity: kalshiLiquidity(m),
    url: kalshiMarketUrl(m),
  };
}
