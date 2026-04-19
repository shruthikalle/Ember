/**
 * POST /api/predictions/analyze
 *
 * Context Engine endpoint. Accepts a market query or slug, resolves the
 * market, then calls the analyst (Claude + live web search) to surface
 * qualitative news context for that market.
 *
 * Streams Server-Sent Events back to the client:
 *   event: status  — progress updates during analysis
 *   event: result  — final JSON payload (analysis | disambiguate)
 *   event: error   — error message
 *
 * Body:
 *   { query?: string, marketSlug?: string }
 *
 * Result payload variants:
 *   { mode: 'analysis', market, context }
 *   { mode: 'disambiguate', question, candidates }
 */

import { NextRequest } from 'next/server';

export const maxDuration = 300;

import {
  getMarketBySlug,
  getEventBySlug,
  searchMarkets,
  type PolymarketMarket,
} from '@/src/lib/polymarket';
import { matchMarket } from '@/src/lib/predictions/market-match';
import { analyzeMarket } from '@/src/lib/predictions/analyst';

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      }

      try {
        const body = await request.json();
        const { query, marketSlug } = body as {
          query?: string;
          marketSlug?: string;
        };

        if (!query && !marketSlug) {
          send('error', { error: 'Either "query" or "marketSlug" is required' });
          controller.close();
          return;
        }

        console.log('[analyze] ═══════════════════════════════════');
        console.log('[analyze] query:', query, '| slug:', marketSlug);

        // ── Resolve market ───────────────────────────────────────────────────
        send('status', { message: 'Resolving market...' });

        let market: PolymarketMarket | null = null;

        if (marketSlug) {
          const [directMarket, event] = await Promise.all([
            getMarketBySlug(marketSlug),
            getEventBySlug(marketSlug),
          ]);
          market = directMarket ?? (event?.markets[0] ?? null);
        }

        if (!market && query) {
          send('status', { message: 'Searching prediction markets...' });
          const candidates = await searchMarkets(query, 10);
          const match = await matchMarket(query, 'YES', candidates);

          if (match.type === 'match') {
            market = match.market;
            console.log(
              `[analyze] matched "${query}" → "${match.market.question}" (conf ${match.confidence.toFixed(2)})`,
            );
          } else if (match.type === 'ambiguous') {
            console.log(
              `[analyze] ambiguous for "${query}": ${match.candidates.length} candidates`,
            );
            send('result', {
              mode: 'disambiguate',
              question: match.question,
              candidates: match.candidates.map((m) => ({
                slug: m.slug,
                question: m.question,
                image: m.image,
                outcomes: safeParseArray(m.outcomes),
                outcomePrices: safeParseArray(m.outcomePrices),
                volume24hr: m.volume24hr ?? 0,
                endDate: m.endDate,
              })),
            });
            controller.close();
            return;
          }
        }

        if (!market) {
          send('error', { error: 'Could not find a matching prediction market.' });
          controller.close();
          return;
        }

        // ── Shape market info ────────────────────────────────────────────────
        const marketInfo = {
          question: market.question,
          slug: market.slug,
          image: market.image,
          outcomes: safeParseArray(market.outcomes),
          outcomePrices: safeParseArray(market.outcomePrices),
          negRisk: market.negRisk ?? false,
          endDate: market.endDate,
          volume24hr: market.volume24hr ?? 0,
        };

        // ── Context Engine analyst ───────────────────────────────────────────
        send('status', { message: 'Searching live news feeds...' });

        const context = await analyzeMarket(market.question, {
          onProgress:     (msg)  => send('status', { message: msg }),
          onSummaryChunk: (text) => send('chunk',  { text }),
        });

        console.log(
          `[analyze] context: sentiment=${context.sentiment} | degraded=${context.degraded ?? false}`,
        );
        console.log('[analyze] ═══════════════════════════════════');

        send('result', {
          mode: 'analysis',
          market: marketInfo,
          context,
        });

        controller.close();
      } catch (err) {
        console.error('[analyze] Unhandled error:', err);
        send('error', {
          error: err instanceof Error ? err.message : 'Internal server error',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function safeParseArray(s: string | undefined | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
