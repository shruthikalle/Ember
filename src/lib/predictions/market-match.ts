/**
 * Prediction market matcher with disambiguation.
 *
 * Given a natural-language query (e.g. "Fed rate cut") and a list of candidate
 * markets, decides whether one is a clear winner or the user needs to pick.
 *
 * Uses Claude for semantic ranking + volume/score heuristics as fallbacks.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PolymarketMarket } from '@/src/lib/polymarket';

let anthropic: Anthropic | null = null;
function getClaude(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// ─── Public types ──────────────────────────────────────────────────────────

export type MatchResult =
  | {
      type: 'match';
      market: PolymarketMarket;
      confidence: number;
      reason: string;
    }
  | {
      type: 'ambiguous';
      candidates: PolymarketMarket[];
      question: string;
    }
  | {
      type: 'no_match';
      reason: string;
    };

// ─── Public API ────────────────────────────────────────────────────────────

export async function matchMarket(
  query: string,
  side: 'YES' | 'NO',
  candidates: PolymarketMarket[],
): Promise<MatchResult> {
  if (candidates.length === 0) {
    return {
      type: 'no_match',
      reason: `No Polymarket markets found for "${query}".`,
    };
  }

  // Filter out closed / inactive
  const active = candidates.filter((m) => m.active !== false && !m.closed);
  const baseline = active.length > 0 ? active : candidates;

  // ── Relevance filter: Polymarket's `_q` returns junk; drop candidates whose
  // question doesn't share a single meaningful token with the query. If nothing
  // passes, we refuse to show random markets and return no_match. ─────────────
  const relevant = filterByTokenOverlap(baseline, query);
  if (relevant.length === 0) {
    return {
      type: 'no_match',
      reason: `No Polymarket markets matched "${query}". Try different keywords.`,
    };
  }
  const pool = relevant;

  if (pool.length === 1) {
    return { type: 'match', market: pool[0], confidence: 1.0, reason: 'Only one candidate' };
  }

  // Sort by 24h volume as baseline signal
  const sorted = [...pool].sort(
    (a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0),
  );

  // ── Heuristic: dominant volume → clear winner even without LLM ──────────
  const top = sorted[0];
  const second = sorted[1];
  const topVol = top.volume24hr ?? 0;
  const secondVol = second?.volume24hr ?? 0;

  const claude = getClaude();

  // Fallback when Claude is not configured
  if (!claude) {
    if (topVol > 0 && topVol >= secondVol * 5) {
      return {
        type: 'match',
        market: top,
        confidence: 0.7,
        reason: `Dominant volume (${fmtVol(topVol)} vs ${fmtVol(secondVol)})`,
      };
    }
    return buildAmbiguous(
      sorted.slice(0, 4),
      `Found ${sorted.length} markets for "${query}". Which one?`,
    );
  }

  // ── Ask Claude to score and pick ────────────────────────────────────────
  const shortList = sorted.slice(0, 8);
  const payload = {
    userQuery: query,
    userSide: side,
    candidates: shortList.map((m) => ({
      slug: m.slug,
      question: m.question,
      volume24hr: m.volume24hr ?? 0,
      endDate: m.endDate,
      yesPrice: getYesPrice(m),
    })),
  };

  try {
    const resp = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      temperature: 0.1,
      system: MARKET_MATCH_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });

    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn('[market-match] JSON parse failed; falling back to volume heuristic', parseErr);
      return volumeFallback(sorted, query);
    }

    // Claude picked a clear winner
    if (parsed.matchedSlug && typeof parsed.matchedSlug === 'string') {
      const matched = shortList.find((m) => m.slug === parsed.matchedSlug);
      if (matched) {
        return {
          type: 'match',
          market: matched,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'Best semantic match',
        };
      }
    }

    // Claude returned ambiguous candidates
    if (Array.isArray(parsed.ambiguousSlugs) && parsed.ambiguousSlugs.length > 1) {
      const selected: PolymarketMarket[] = parsed.ambiguousSlugs
        .map((slug: unknown): PolymarketMarket | undefined =>
          typeof slug === 'string' ? shortList.find((m) => m.slug === slug) : undefined,
        )
        .filter((m: PolymarketMarket | undefined): m is PolymarketMarket => !!m);

      if (selected.length > 1) {
        return buildAmbiguous(
          selected.slice(0, 4),
          typeof parsed.question === 'string' && parsed.question
            ? parsed.question
            : `Found multiple markets for "${query}". Which one?`,
        );
      }
    }
  } catch (err) {
    console.warn('[market-match] Claude request failed, falling back to volume heuristic:', err);
  }

  // Final fallback: show top 4 by volume with a generic question
  return volumeFallback(sorted, query);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

// Common English stopwords + question-framing filler that shouldn't count as
// "topical" overlap. "Bitcoin" matters; "will", "the", "in" don't.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'at', 'be', 'by', 'for', 'in', 'is', 'it', 'of', 'on',
  'or', 'the', 'to', 'with', 'will', 'would', 'are', 'do', 'does', 'not',
  'no', 'yes', 'how', 'what', 'when', 'where', 'who', 'why', 'which', 'than',
  'this', 'that', 'as', 'into', 'from', 'after', 'before', 'any', 'all',
  'bet', 'buy', 'sell', 'long', 'short', 'on', 'up', 'down',
]);

// Short-form expansions so "Dec"/"Feb"/"Jan" still match "December"/etc.
const MONTH_ALIASES: Record<string, string> = {
  jan: 'january', feb: 'february', mar: 'march', apr: 'april',
  jun: 'june', jul: 'july', aug: 'august', sep: 'september',
  oct: 'october', nov: 'november', dec: 'december',
};

// Crypto ticker ↔ full-name aliases (bidirectional)
const CRYPTO_ALIASES: Record<string, string[]> = {
  bitcoin: ['btc'],
  btc: ['bitcoin'],
  ethereum: ['eth'],
  eth: ['ethereum'],
  solana: ['sol'],
  sol: ['solana'],
  dogecoin: ['doge'],
  doge: ['dogecoin'],
  xrp: ['ripple'],
  ripple: ['xrp'],
  bnb: ['binance'],
};

/** Expand a single token into itself + any known aliases. */
function expandToken(t: string): string[] {
  return [t, ...(CRYPTO_ALIASES[t] ?? [])];
}

/**
 * Expand compact number notation: "100k" → ["100k","100"], "1m" → ["1m","1"],
 * "150k" → ["150k","150"]. This lets queries like "BTC above 100k" match market
 * titles that spell out "$100,000" (which tokenises to "100" + "000").
 */
function expandNumeric(t: string): string[] {
  const km = t.match(/^(\d+)k$/);
  if (km) return [t, km[1]];
  const mm = t.match(/^(\d+)m$/);
  if (mm) return [t, mm[1]];
  return [t];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => MONTH_ALIASES[t] ?? t);
}

/** Build the full expanded token set for a text (includes aliases + numeric expansions). */
function expandedTokenSet(text: string): Set<string> {
  const base = tokenize(text);
  const result = new Set<string>();
  for (const t of base) {
    for (const alias of expandToken(t)) {
      result.add(alias);
      for (const num of expandNumeric(alias)) result.add(num);
    }
  }
  return result;
}

function filterByTokenOverlap(
  candidates: PolymarketMarket[],
  query: string,
): PolymarketMarket[] {
  const qTokens = expandedTokenSet(query);
  if (qTokens.size === 0) return candidates; // Don't over-filter empty queries

  return candidates.filter((m) => {
    const haystack = `${m.question ?? ''} ${m.slug ?? ''} ${m.description ?? ''}`;
    const mTokens = expandedTokenSet(haystack);
    // Require at least one topical token match
    for (const t of qTokens) if (mTokens.has(t)) return true;
    return false;
  });
}

function volumeFallback(sorted: PolymarketMarket[], query: string): MatchResult {
  const top = sorted[0];
  const second = sorted[1];
  const topVol = top.volume24hr ?? 0;
  const secondVol = second?.volume24hr ?? 0;

  if (topVol > 0 && topVol >= secondVol * 5) {
    return {
      type: 'match',
      market: top,
      confidence: 0.7,
      reason: `Dominant volume (${fmtVol(topVol)} vs ${fmtVol(secondVol)})`,
    };
  }

  return buildAmbiguous(
    sorted.slice(0, 4),
    `Found ${sorted.length} markets for "${query}". Which one?`,
  );
}

function buildAmbiguous(candidates: PolymarketMarket[], question: string): MatchResult {
  return { type: 'ambiguous', candidates, question };
}

function getYesPrice(m: PolymarketMarket): number {
  try {
    const prices = JSON.parse(m.outcomePrices) as string[];
    return parseFloat(prices[0] ?? '0');
  } catch {
    return 0;
  }
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Claude system prompt ──────────────────────────────────────────────────

const MARKET_MATCH_PROMPT = `You help users place bets on Polymarket.

Given a user's query, their side (YES or NO), and a list of candidate markets (sorted by 24h volume descending), you decide:

1. If ONE market is clearly the best match — return just that one.
2. If MULTIPLE markets could reasonably match and the user needs to pick — return up to 4 of them with a one-line clarifying question.

Output JSON ONLY. No prose, no markdown fences.

Schema:
{
  "matchedSlug": string | null,      // non-null ONLY if there's a clear winner
  "confidence": number,              // 0.0 to 1.0
  "reason": string,                  // one line explanation (always present)
  "ambiguousSlugs": string[] | null, // 2-4 slugs when ambiguous
  "question": string | null          // one-sentence conversational question when ambiguous
}

RULES FOR "CLEAR WINNER":
- The top candidate is clearly semantically closer to the query than any other, OR
- The top candidate has >=5x the 24h volume of the runner-up AND both are valid matches.

RULES FOR "AMBIGUOUS":
- When 2+ markets match the query with similar semantic fit.
- When the user's query doesn't specify a distinguishing detail (timeframe, threshold, which of multiple events).
- Highlight WHAT differs between them in the clarifying question (date, cut size, threshold, specific event).
- Keep the question ONE sentence, conversational. Don't say "Please select" — say things like "Are you betting on X, Y, or Z?"
- Don't number the markets — the UI renders a list.

NEGATION HANDLING:
- If the user's query is phrased as a negated event (e.g. "Trump NOT winning"), still match a positively-framed market ("Trump wins") — the caller will flip side to NO.

OUTPUT EXAMPLES

Example 1 — clear winner (semantic):
Query: "Trump 2028 primary"
Candidates include a Trump-2028-primary-specific market with $3.1M volume. Other candidates are unrelated.
Output:
{
  "matchedSlug": "trump-gop-primary-2028",
  "confidence": 0.95,
  "reason": "Exact topic and timeframe match, high volume",
  "ambiguousSlugs": null,
  "question": null
}

Example 2 — ambiguous (multiple valid):
Query: "Fed rate cut"
Candidates: "Fed cuts in Dec 2026" ($2.3M), "Fed cuts at least once in 2026" ($1.1M), "Fed cuts 50bps Dec 2026" ($620K).
Output:
{
  "matchedSlug": null,
  "confidence": 0.45,
  "reason": "Multiple Fed cut markets with different specifics",
  "ambiguousSlugs": ["fed-dec-2026", "fed-any-2026", "fed-50bps-dec"],
  "question": "Are you betting on a December cut specifically, any cut happening this year, or a larger 50bp cut?"
}

Example 3 — dominant volume winner:
Query: "Bitcoin $100k"
Candidates: "BTC above $100k by EOY" ($12M volume), "BTC above $100k by March" ($400K), "BTC above $100k by 2030" ($80K).
Output:
{
  "matchedSlug": "btc-100k-eoy",
  "confidence": 0.85,
  "reason": "Dominant volume and most-discussed timeframe",
  "ambiguousSlugs": null,
  "question": null
}`;
