/**
 * POST /api/predictions/trade
 *
 * Server-side Polymarket trade execution via official SDK.
 * No wallet signing needed — server signs with AGENT_PRIVATE_KEY
 * and posts via CLOB API creds.
 *
 * Body: { command?, marketSlug?, action?, amountUsd?, tokenIds? }
 *
 * Flow:
 *   1. Parse intent: LLM (NL command) or direct params from UI
 *   2. Match market → extract clobTokenIds
 *   3. Execute trade via SDK: createAndPostMarketOrder (FOK)
 *   4. Return result
 */

import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

import { parsePredictionIntent } from '@/src/lib/llm';
import {
  getEventBySlug,
  getMarketBySlug,
  getPriceFromMarket,
  searchMarkets,
  parseClobTokenIds,
  type PolymarketMarket,
} from '@/src/lib/polymarket';
import { executeMarketOrder, getPrice } from '@/src/lib/polymarket-client';
import { matchMarket } from '@/src/lib/predictions/market-match';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      command,
      marketSlug,
      action,
      amountUsd,
      tokenIds: clientTokenIds,
      currentPrice: clientPrice,
      confirm,
    } = body as {
      command?: string;
      marketSlug?: string;
      action?: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO';
      amountUsd?: number;
      tokenIds?: { yes: string; no: string };
      /** Price supplied by the client from its own market data — skips Gamma re-fetch. */
      currentPrice?: number;
      confirm?: boolean;
    };

    if (!command && !marketSlug) {
      return NextResponse.json(
        { error: 'Either "command" (NL) or "marketSlug" + "action" + "amountUsd" required' },
        { status: 400 },
      );
    }

    console.log('[PredictionTrade] ═══════════════════════════════════');
    console.log('[PredictionTrade] Command:', command || `${action} on ${marketSlug}`);

    // ── Resolve intent ────────────────────────────────────────────────────
    let resolvedAction: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO';
    let resolvedAmountUsd: number;
    let resolvedSlug: string | undefined;
    let resolvedMarket: PolymarketMarket | null = null;

    if (command) {
      const parsed = await parsePredictionIntent(command);
      if (!parsed.intent || parsed.intent.action === 'INFO') {
        return NextResponse.json(
          { error: parsed.error || 'Could not parse a trade action from your command. Try "bet $10 yes on [topic]"' },
          { status: 400 },
        );
      }
      resolvedAction = parsed.intent.action as 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO';
      resolvedAmountUsd = parsed.intent.amountUsd ?? 10;
      resolvedSlug = parsed.intent.slug;
    } else {
      resolvedAction = action!;
      resolvedAmountUsd = amountUsd ?? 10;
      resolvedSlug = marketSlug;
    }

    // ── Match market ──────────────────────────────────────────────────────
    if (resolvedSlug) {
      resolvedMarket = await getMarketBySlug(resolvedSlug);
      if (!resolvedMarket) {
        const event = await getEventBySlug(resolvedSlug);
        if (event && event.markets.length > 0) {
          resolvedMarket = event.markets[0];
        }
      }
    }

    if (!resolvedMarket) {
      const searchText = command || resolvedSlug || '';
      if (searchText) {
        const results = await searchMarkets(searchText, 10);

        const side: 'YES' | 'NO' =
          resolvedAction === 'BUY_YES' || resolvedAction === 'SELL_YES' ? 'YES' : 'NO';

        const match = await matchMarket(searchText, side, results);

        if (match.type === 'match') {
          resolvedMarket = match.market;
          console.log(
            `[PredictionTrade] Matched "${searchText}" → "${match.market.question}" (confidence ${match.confidence.toFixed(2)}: ${match.reason})`,
          );
        } else if (match.type === 'ambiguous') {
          // Bail out — return candidates to the client for the user to pick from.
          // The client will re-call /trade with an explicit marketSlug + action + amountUsd.
          console.log(
            `[PredictionTrade] Ambiguous for "${searchText}": ${match.candidates.length} candidates`,
          );
          return NextResponse.json({
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
            intent: {
              action: resolvedAction,
              amountUsd: resolvedAmountUsd,
            },
          });
        }
        // match.type === 'no_match' — fall through to the 404 below
      }
    }

    if (!resolvedMarket) {
      return NextResponse.json({ error: 'Could not find matching prediction market' }, { status: 404 });
    }

    // ── Parse market display info ────────────────────────────────────────
    let outcomePrices: string[] = [];
    let outcomes: string[] = [];
    try {
      outcomePrices = JSON.parse(resolvedMarket.outcomePrices || '[]');
      outcomes = JSON.parse(resolvedMarket.outcomes || '[]');
    } catch { /* ignore */ }

    const marketInfo = {
      question: resolvedMarket.question,
      slug: resolvedMarket.slug,
      image: resolvedMarket.image,
      outcomes,
      outcomePrices,
      negRisk: resolvedMarket.negRisk ?? false,
    };

    // ── Extract token IDs ─────────────────────────────────────────────────
    const tokenIds = clientTokenIds || parseClobTokenIds(resolvedMarket);
    if (!tokenIds) {
      return NextResponse.json(
        { error: 'Market does not have CLOB token IDs — trading not available for this market', market: marketInfo },
        { status: 400 },
      );
    }

    const isYes = resolvedAction === 'BUY_YES' || resolvedAction === 'SELL_YES';
    const isBuy = resolvedAction === 'BUY_YES' || resolvedAction === 'BUY_NO';
    const tokenId = isYes ? tokenIds.yes : tokenIds.no;
    const side = isBuy ? 'BUY' : 'SELL';

    // ── Get current price ────────────────────────────────────────────────
    // Priority:
    //   1. clientPrice — sent by the widget from its own market data (fastest, no extra fetch)
    //   2. Gamma market fields (bestBid/bestAsk/outcomePrices) — from the market we already fetched
    //   3. CLOB API getPrice — last resort, often geo-blocked and slow
    let currentPrice: number | null = null;

    const isValidClientPrice =
      typeof clientPrice === 'number' &&
      Number.isFinite(clientPrice) &&
      clientPrice > 0 &&
      clientPrice < 1;

    if (isValidClientPrice) {
      currentPrice = clientPrice!;
      console.log('[PredictionTrade] Using client-supplied price:', currentPrice);
    } else {
      currentPrice = getPriceFromMarket(resolvedMarket, resolvedAction);
    }

    if (currentPrice === null) {
      try {
        currentPrice = await getPrice(tokenId, side);
      } catch (err) {
        console.warn('[PredictionTrade] CLOB getPrice failed (likely geo-blocked):', err);
      }
    }

    if (!currentPrice) {
      return NextResponse.json(
        { error: 'No liquidity available for this market right now.', market: marketInfo },
        { status: 400 },
      );
    }

    const estimatedShares = resolvedAmountUsd / currentPrice;

    // ── Preview mode (no confirm flag) ───────────────────────────────────
    if (!confirm) {
      console.log('[PredictionTrade] Preview:', {
        market: resolvedMarket.question,
        action: resolvedAction,
        amount: resolvedAmountUsd,
        price: currentPrice,
        shares: estimatedShares.toFixed(2),
      });

      return NextResponse.json({
        mode: 'preview',
        market: marketInfo,
        trade: {
          action: resolvedAction,
          side,
          tokenId,
          amountUsd: resolvedAmountUsd,
          price: currentPrice,
          estimatedShares: parseFloat(estimatedShares.toFixed(2)),
          outcome: isYes ? 'Yes' : 'No',
        },
      });
    }

    // ── Execute trade via SDK ────────────────────────────────────────────
    console.log('[PredictionTrade] EXECUTING:', {
      tokenId: tokenId.slice(0, 20) + '...',
      amount: resolvedAmountUsd,
      side,
      price: currentPrice,
    });

    const result = await executeMarketOrder({
      tokenID: tokenId,
      amount: resolvedAmountUsd,
      side,
      price: currentPrice,
    });

    if (!result.success) {
      console.error('[PredictionTrade] Trade failed:', result.error);
      return NextResponse.json(
        { error: result.error || 'Trade execution failed', market: marketInfo },
        { status: 400 },
      );
    }

    console.log('[PredictionTrade] Trade success:', result.orderID);
    console.log('[PredictionTrade] ═══════════════════════════════════');

    return NextResponse.json({
      mode: 'executed',
      market: marketInfo,
      trade: {
        action: resolvedAction,
        side,
        tokenId,
        amountUsd: resolvedAmountUsd,
        price: currentPrice,
        estimatedShares: parseFloat(estimatedShares.toFixed(2)),
        outcome: isYes ? 'Yes' : 'No',
      },
      result: {
        orderID: result.orderID,
        transactIDs: result.transactIDs,
        status: result.status,
      },
    });
  } catch (err) {
    console.error('[PredictionTrade] Unhandled error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
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
