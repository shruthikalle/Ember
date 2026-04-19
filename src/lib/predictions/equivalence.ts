/**
 * Logical-equivalence gate for Polymarket ↔ Kalshi pairs.
 *
 * The similarity matcher pairs markets by topic (semantic cosine), which is
 * too permissive for arbitrage: two markets on "NBA Rookie of the Year" with
 * different subject specificity ("Ace Bailey wins" vs "any top-5 pick wins")
 * produce wildly asymmetric payoffs. This module filters those out in two
 * stages:
 *
 *   1. `boundaryPrefilter` — pure-regex reject on numeric / range / threshold
 *      mismatches. Cheap, runs synchronously on every candidate.
 *   2. `checkEquivalence` — Claude Haiku verdict on whether two markets
 *      resolve on logically identical events. Results are cached in the
 *      existing `similar_cache` table with a 30-day TTL.
 */

import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getSimilarCache, putSimilarCache } from '@/src/lib/db';

// ─── Prefilter ──────────────────────────────────────────────────────────────

export interface PrefilterResult {
  reject: boolean;
  reason?: string;
}

/**
 * Pull all standalone numbers out of a string. Percents, decimals, and
 * integers are all accepted — the unit suffix is stripped. Years are kept
 * since a year mismatch is itself a resolution mismatch.
 */
function extractNumbers(s: string): number[] {
  if (!s) return [];
  const matches = s.match(/-?\d+(?:\.\d+)?/g) || [];
  return matches.map((m) => parseFloat(m)).filter(Number.isFinite);
}

/** Canonicalize numeric values — 10, 10.0, 10.00 all collapse to "10". */
function normalizeNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Reject pairs whose titles contain asymmetric numeric sets. If one side
 * references a threshold or range boundary the other doesn't, they almost
 * certainly have different resolution criteria — a false arb.
 *
 * Catches:
 *   • "10-19 ships" vs "Above 10"            → Poly has 19, Kalshi doesn't.
 *   • "Ace Bailey wins ROY"  vs "Top 5 pick wins ROY" → Kalshi has 5, Poly doesn't.
 *   • "Fed hikes by 25bp"    vs "Fed hikes to 4.50%"  → different numbers entirely.
 */
export function boundaryPrefilter(
  polyText: string,
  kalshiText: string,
): PrefilterResult {
  const pNums = new Set(extractNumbers(polyText).map(normalizeNum));
  const kNums = new Set(extractNumbers(kalshiText).map(normalizeNum));

  if (pNums.size === 0 && kNums.size === 0) return { reject: false };

  for (const n of pNums) {
    if (!kNums.has(n)) {
      return {
        reject: true,
        reason: `Polymarket references ${n} but Kalshi does not — likely different thresholds.`,
      };
    }
  }
  for (const n of kNums) {
    if (!pNums.has(n)) {
      return {
        reject: true,
        reason: `Kalshi references ${n} but Polymarket does not — likely different thresholds.`,
      };
    }
  }
  return { reject: false };
}

// ─── LLM equivalence gate ───────────────────────────────────────────────────

export interface EquivalenceVerdict {
  equivalent: boolean;
  reason: string;
  cached: boolean;
}

let anthropic: Anthropic | null = null;
function getClaude(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// 30 days — equivalence is a property of the market text, which only changes
// if either venue relists. A pair hash already changes when text changes.
const EQUIV_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cacheKey(polyText: string, kalshiText: string): string {
  return (
    'equiv:' +
    crypto.createHash('sha1').update(`${polyText}\n||\n${kalshiText}`).digest('hex')
  );
}

/**
 * Ask Claude Haiku whether two markets resolve on identical events. Returns
 * the verdict with a one-sentence reason. Results are cached in sqlite by
 * pair hash, so repeat scans skip the API call.
 */
export async function checkEquivalence(
  polyText: string,
  kalshiText: string,
): Promise<EquivalenceVerdict> {
  const key = cacheKey(polyText, kalshiText);

  try {
    const hit = getSimilarCache(key, EQUIV_TTL_MS) as
      | { equivalent: boolean; reason: string }
      | null;
    if (hit && typeof hit === 'object' && 'equivalent' in hit) {
      return { equivalent: !!hit.equivalent, reason: hit.reason || '', cached: true };
    }
  } catch { /* ignore */ }

  const claude = getClaude();
  if (!claude) {
    // No key — permissive default so the feature still works in dev. Don't
    // cache; the downstream analyst gate will still flag obvious false arbs.
    return {
      equivalent: true,
      reason: 'Equivalence gate unavailable (no ANTHROPIC_API_KEY).',
      cached: false,
    };
  }

  const system = `You check whether two prediction markets resolve on logically identical events.

Two markets are EQUIVALENT only if, in every possible world, YES on market A implies YES on market B and vice versa. Topic overlap is NOT enough. If the markets differ in any of: threshold value, range boundaries, timeframe, specific subject (e.g. "Bailey wins X" vs "any top-5 pick wins X"), tie-break rules, or resolution cutoff, they are NOT equivalent — even if both are plausible bets.

Respond with STRICT JSON only, no prose outside the JSON, no code fences:
{"equivalent": boolean, "reason": "one short sentence describing why"}`;

  const user = `Market A (Polymarket): ${polyText}

Market B (Kalshi): ${kalshiText}

Do these always resolve together in every possible outcome?`;

  try {
    const resp = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = (resp.content as any[])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();

    const parsed = extractJson(text);
    const equivalent = !!(parsed && typeof parsed === 'object' && (parsed as any).equivalent === true);
    const rawReason =
      parsed && typeof (parsed as any).reason === 'string' ? ((parsed as any).reason as string) : '';
    const reason =
      rawReason.slice(0, 240) ||
      (equivalent ? 'Markets resolve identically.' : 'Markets may diverge on some outcomes.');

    try {
      putSimilarCache(key, { equivalent, reason });
    } catch { /* non-fatal */ }

    return { equivalent, reason, cached: false };
  } catch (err) {
    // API failure — conservative: reject and do NOT cache.
    return {
      equivalent: false,
      reason: `Equivalence check failed: ${truncate(err instanceof Error ? err.message : String(err), 160)}`,
      cached: false,
    };
  }
}

function extractJson(text: string): unknown | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
