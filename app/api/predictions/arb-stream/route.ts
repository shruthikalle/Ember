/**
 * GET /api/predictions/arb-stream
 *
 * Server-Sent Events stream. Scans Polymarket ↔ Kalshi for profitable
 * cross-exchange arbs, then streams a Claude analyst's take on each one
 * (with live Polymarket/Kalshi quotes and a ready-to-execute trade payload).
 *
 * Event types (all JSON after `data:`):
 *   { type: 'status',   message: string }
 *   { type: 'meta',     scanned: { poly: number; kalshi: number }; profitable: number }
 *   { type: 'arb',      id: string; arb: StreamedArb }          // quote + plan
 *   { type: 'token',    id: string; text: string }              // LLM delta
 *   { type: 'arb_done', id: string }
 *   { type: 'done' }
 *   { type: 'error',    message: string }
 *
 * Query params:
 *   - maxNotional (default 100)   — USD budget per arb for sizing
 *   - topN        (default 3)     — how many arbs to analyze
 *   - minRoi      (default 0.005) — skip arbs with ROI below this (0.5%)
 */

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { computeArb, type ArbCalculation } from '@/src/lib/predictions/arb';
import { boundaryPrefilter, checkEquivalence } from '@/src/lib/predictions/equivalence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

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

interface StreamedArb {
  id: string;
  similarity: number;
  polymarket: SimilarPair['polymarket'];
  kalshi: SimilarPair['kalshi'];
  arb: ArbCalculation;
  /** Pre-built trade payload the client can post to /api/predictions/trade. */
  trade: {
    marketSlug: string;
    action: 'BUY_YES' | 'BUY_NO';
    amountUsd: number;
  };
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const maxNotional = clamp(parseFloat(params.get('maxNotional') || '100'), 5, 5_000);
  const topN = clamp(parseInt(params.get('topN') || '3', 10), 1, 10);
  const minRoi = clamp(parseFloat(params.get('minRoi') || '0.005'), 0, 1);

  const encoder = new TextEncoder();
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          isClosed = true;
        }
      };
      const close = () => {
        if (isClosed) return;
        isClosed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal.addEventListener('abort', () => { isClosed = true; });

      try {
        send({ type: 'status', message: 'Scanning Polymarket × Kalshi…' });

        // Reuse the /similar endpoint — it has 2-min pair caching and a
        // permanent embedding cache, so repeat scans are nearly free.
        // Raise minScore to 0.75 — below this, pairs are topical at best;
        // real arbs sit near 0.85+.
        // polyCap=2000 — top 2000 markets by liquidity is more than enough
        // to surface real arbs and avoids paginating the full 10k+ corpus.
        // kalshiCap=2000 — Kalshi has ~2k active tradeable markets in practice.
        const similarRes = await fetch(
          `${req.nextUrl.origin}/api/predictions/similar?limit=60&minScore=0.75&polyCap=2000&kalshiCap=2000`,
          { signal: req.signal },
        );
        if (!similarRes.ok) {
          const err = await similarRes.json().catch(() => ({}));
          throw new Error(err.error || `Similar scan failed (HTTP ${similarRes.status})`);
        }
        const similarData = (await similarRes.json()) as {
          pairs: SimilarPair[];
          polyCount: number;
          kalshiCount: number;
        };

        // Compute arb on each pair; keep only profitable ones above minRoi.
        // Then gate through the prefilter + LLM equivalence check before
        // showing them as arbs — semantic similarity alone produces
        // false positives (different thresholds, specific vs group, etc.).
        const profitablePairs: Array<{
          pair: SimilarPair;
          arb: ArbCalculation;
          polyAction: 'BUY_YES' | 'BUY_NO';
          polyAmountUsd: number;
        }> = [];
        for (const p of similarData.pairs || []) {
          if (p.polymarket.yesPrice === null || p.kalshi.yesPrice === null) continue;
          const arb = computeArb(p.polymarket.yesPrice, p.kalshi.yesPrice, maxNotional);
          if (!arb || !arb.profitable || arb.roi < minRoi) continue;

          const polyAction: 'BUY_YES' | 'BUY_NO' =
            arb.direction.buyYesOn === 'polymarket' ? 'BUY_YES' : 'BUY_NO';
          const polyLegPrice = polyAction === 'BUY_YES' ? arb.polyYes : 1 - arb.polyYes;
          const polyAmountUsd = +(arb.pairs * polyLegPrice).toFixed(2);

          profitablePairs.push({ pair: p, arb, polyAction, polyAmountUsd });
        }

        // Sort by net profit so we spend LLM budget on the most valuable
        // candidates first.
        profitablePairs.sort((a, b) => b.arb.netProfitUsd - a.arb.netProfitUsd);

        send({
          type: 'status',
          message: `Checking ${profitablePairs.length} profitable pair${profitablePairs.length === 1 ? '' : 's'} for true equivalence…`,
        });

        // Stage 1: cheap regex prefilter. Stage 2: Haiku gate (cached).
        // Stop once we have enough survivors to fill topN.
        const candidates: StreamedArb[] = [];
        let rejectedPrefilter = 0;
        let rejectedGate = 0;
        for (const pp of profitablePairs) {
          if (isClosed) break;
          if (candidates.length >= topN) break;

          const polyText = pp.pair.polymarket.question;
          const kalshiText = [pp.pair.kalshi.title, pp.pair.kalshi.subtitle]
            .filter(Boolean)
            .join(' — ');

          const pre = boundaryPrefilter(polyText, kalshiText);
          if (pre.reject) {
            rejectedPrefilter++;
            continue;
          }

          const eq = await checkEquivalence(polyText, kalshiText);
          if (!eq.equivalent) {
            rejectedGate++;
            continue;
          }

          candidates.push({
            id: `${pp.pair.polymarket.slug}__${pp.pair.kalshi.ticker}`,
            similarity: pp.pair.similarity,
            polymarket: pp.pair.polymarket,
            kalshi: pp.pair.kalshi,
            arb: pp.arb,
            trade: {
              marketSlug: pp.pair.polymarket.slug,
              action: pp.polyAction,
              amountUsd: pp.polyAmountUsd,
            },
          });
        }

        send({
          type: 'meta',
          scanned: { poly: similarData.polyCount, kalshi: similarData.kalshiCount },
          profitable: profitablePairs.length,
          rejected: { prefilter: rejectedPrefilter, gate: rejectedGate },
          survivors: candidates.length,
        });

        if (candidates.length === 0) {
          send({
            type: 'status',
            message:
              profitablePairs.length === 0
                ? 'No profitable pairs right now.'
                : `All ${profitablePairs.length} profitable pairs failed the equivalence check — no true arbs.`,
          });
          send({ type: 'done' });
          close();
          return;
        }
        const top = candidates;

        const claude = getClaude();

        for (const arb of top) {
          if (isClosed) break;

          send({ type: 'arb', id: arb.id, arb });

          if (!claude) {
            send({
              type: 'token',
              id: arb.id,
              text:
                'Analyst unavailable — set ANTHROPIC_API_KEY to enable streamed commentary. ' +
                'Quote + trade plan above are still valid.',
            });
            send({ type: 'arb_done', id: arb.id });
            continue;
          }

          await streamArbCommentary(claude, arb, send, () => isClosed);
          send({ type: 'arb_done', id: arb.id });
        }

        send({ type: 'done' });
        close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: msg });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ─── Claude streaming ───────────────────────────────────────────────────────

let anthropic: Anthropic | null = null;
function getClaude(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

const ARB_SYSTEM_PROMPT = `You are a rigorous prediction-market arbitrage analyst. Your most important job is to detect FALSE arbs.

The two markets were paired by SEMANTIC similarity, not logical equivalence. They may sound alike but resolve on different events. Before accepting the arb plan, check whether the two markets would ALWAYS settle together in every possible outcome — not just most of the time.

Classic false-arb patterns to flag:
  • "Specific entity X wins" vs "any of group G wins" — these diverge whenever another member of G wins.
  • Different timeframes, resolution dates, or cutoff thresholds.
  • Different tie-break, settlement, or disqualification rules.
  • Markets about correlated but distinct events (e.g., "Team wins title" vs "Player wins MVP").
  • Asymmetric resolution (one market can resolve NO while the other is still open).

Decide first: is this a TRUE arb (identical resolution → locked payout) or a CORRELATION bet (P&L depends on which specific outcome occurs)?

If it is a CORRELATION bet, LEAD with that in bold: "**Not a true arb**" — then explain the scenario where the two legs diverge and the user loses. Do NOT present this as a trade.

If it IS a true arb, output:
  1. What the bet is (one line).
  2. The trade: which leg on which exchange, at what price.
  3. Why this is an arb: the spread + fee math, and net profit.
  4. Execution risks: slippage, fills at worse prices, thin liquidity, exchange risk.

Under 150 words. Short paragraphs or 3–4 tight bullets. No JSON, no code fences, no citation tags. Never recommend sizing beyond the plan provided.`;

async function streamArbCommentary(
  claude: Anthropic,
  arb: StreamedArb,
  send: (obj: unknown) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const polyLegPrice = arb.trade.action === 'BUY_YES' ? arb.arb.polyYes : 1 - arb.arb.polyYes;
  const kalshiLegPrice =
    arb.arb.direction.buyYesOn === 'kalshi' ? arb.arb.kalshiYes : 1 - arb.arb.kalshiYes;

  const payload = {
    polymarket: {
      question: arb.polymarket.question,
      yesPrice: arb.arb.polyYes,
      url: arb.polymarket.url,
    },
    kalshi: {
      title: arb.kalshi.title,
      subtitle: arb.kalshi.subtitle,
      yesPrice: arb.arb.kalshiYes,
      ticker: arb.kalshi.ticker,
    },
    spread: arb.arb.spread,
    similarity: arb.similarity,
    plan: {
      buyYesOn: arb.arb.direction.buyYesOn,
      buyNoOn: arb.arb.direction.buyNoOn,
      pairs: arb.arb.pairs,
      costPerPair: arb.arb.costPerPair,
      deployedUsd: arb.arb.deployedUsd,
      grossProfitUsd: arb.arb.grossProfitUsd,
      polyFeesUsd: arb.arb.polyFeesUsd,
      kalshiFeesUsd: arb.arb.kalshiFeesUsd,
      netProfitUsd: arb.arb.netProfitUsd,
      roi: arb.arb.roi,
      polymarketLeg: {
        action: arb.trade.action,
        pricePerShare: +polyLegPrice.toFixed(4),
        amountUsd: arb.trade.amountUsd,
      },
      kalshiLeg: {
        side: arb.arb.direction.buyYesOn === 'kalshi' ? 'BUY_YES' : 'BUY_NO',
        pricePerShare: +kalshiLegPrice.toFixed(4),
      },
    },
  };

  const userContent =
    `Analyze this cross-exchange arb opportunity and produce the commentary described in your instructions.\n\n` +
    `${JSON.stringify(payload, null, 2)}`;

  try {
    const streamResp = claude.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 600,
      system: ARB_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    for await (const event of streamResp) {
      if (isCancelled()) break;
      if (event.type === 'content_block_delta') {
        const delta = (event as { delta?: { type?: string; text?: string } }).delta;
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
          send({ type: 'token', id: arb.id, text: delta.text });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send({ type: 'token', id: arb.id, text: `\n(analyst error: ${truncate(msg, 140)})` });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

function truncate(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
