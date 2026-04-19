/**
 * POST /api/predictions/close
 *
 * Close (sell) an existing position on Polymarket. Places a FOK market SELL
 * for the shares you hold at the current best bid.
 *
 * Body:
 *   { slug: string, outcome: 'Yes' | 'No', shares?: number }
 *
 * If `shares` is omitted we try to infer it from the live positions endpoint
 * so the caller doesn't have to know the exact share balance.
 *
 * Response:
 *   { success: true, orderID, status, proceeds }
 *   { error }
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  getMarketBySlug,
  getEventBySlug,
  parseClobTokenIds,
  getPriceFromMarket,
  type PolymarketMarket,
} from '@/src/lib/polymarket';
import { executeMarketOrder, getPrice } from '@/src/lib/polymarket-client';

const DATA_API = 'https://data-api.polymarket.com';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      slug,
      outcome,
      shares: sharesOverride,
      tokenId: tokenIdOverride,
    } = body as {
      slug?: string;
      outcome?: string;
      shares?: number;
      tokenId?: string;
    };

    if (!slug || !outcome) {
      return NextResponse.json(
        { error: '`slug` and `outcome` ("Yes" | "No") are required.' },
        { status: 400 },
      );
    }

    const isYes = outcome.toLowerCase() === 'yes';

    // ── Resolve market ────────────────────────────────────────────────────
    let market: PolymarketMarket | null = await getMarketBySlug(slug);
    if (!market) {
      const event = await getEventBySlug(slug);
      if (event && event.markets.length > 0) market = event.markets[0];
    }
    if (!market) {
      return NextResponse.json({ error: `Market not found for slug "${slug}"` }, { status: 404 });
    }

    // Prefer the tokenId the client already has (from /positions). Fall back
    // to deriving from the market's clobTokenIds if not supplied.
    let tokenId = tokenIdOverride;
    if (!tokenId) {
      const tokenIds = parseClobTokenIds(market);
      if (!tokenIds) {
        return NextResponse.json({ error: 'Market has no CLOB token IDs.' }, { status: 400 });
      }
      tokenId = isYes ? tokenIds.yes : tokenIds.no;
    }
    const action: 'SELL_YES' | 'SELL_NO' = isYes ? 'SELL_YES' : 'SELL_NO';

    // ── Determine shares to sell ──────────────────────────────────────────
    let sharesToSell = sharesOverride;
    if (!sharesToSell || sharesToSell <= 0) {
      // Fallback: look up from data-api (only used if client didn't pass shares).
      const address = process.env.POLY_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS;
      if (address) {
        try {
          const res = await fetch(
            `${DATA_API}/positions?user=${address.toLowerCase()}&limit=100&sizeThreshold=0.01`,
            { cache: 'no-store' },
          );
          if (res.ok) {
            const positions = (await res.json()) as Array<{ asset: string; size: number }>;
            const match = positions.find((p) => p.asset === tokenId);
            console.log('[PredictionClose] Position lookup:', {
              tokenIdSlice: tokenId.slice(0, 20) + '...',
              totalPositions: positions.length,
              matched: !!match,
              size: match?.size,
            });
            if (match) sharesToSell = match.size;
          }
        } catch (err) {
          console.warn('[PredictionClose] Position lookup failed:', err);
        }
      }
    }

    if (!sharesToSell || sharesToSell <= 0) {
      return NextResponse.json(
        { error: 'No shares of this outcome to sell.' },
        { status: 400 },
      );
    }

    // ── Get current price (best bid) ──────────────────────────────────────
    // For a SELL, we want the bid side. getPriceFromMarket handles the
    // YES/NO bid/ask mapping.
    let currentPrice: number | null = getPriceFromMarket(market, action);
    if (currentPrice === null) {
      try {
        currentPrice = await getPrice(tokenId, 'SELL');
      } catch (err) {
        console.warn('[PredictionClose] CLOB getPrice failed:', err);
      }
    }

    if (!currentPrice) {
      return NextResponse.json(
        { error: 'No bid liquidity — cannot close at market right now.' },
        { status: 400 },
      );
    }

    // ── Execute the SELL ──────────────────────────────────────────────────
    console.log('[PredictionClose] ═══════════════════════════════════');
    console.log('[PredictionClose] Closing:', {
      market: market.question,
      outcome,
      shares: sharesToSell,
      price: currentPrice,
      estimatedProceeds: (sharesToSell * currentPrice).toFixed(4),
    });

    // NOTE: For SELL orders, the Polymarket SDK expects `amount` in SHARES,
    // not USDC (opposite of BUY). The executeMarketOrder wrapper passes
    // amount through untouched, so this is correct.
    const result = await executeMarketOrder({
      tokenID: tokenId,
      amount: sharesToSell,
      side: 'SELL',
      price: currentPrice,
    });

    if (!result.success) {
      console.error('[PredictionClose] Close failed:', result.error);
      return NextResponse.json({ error: result.error || 'Close failed' }, { status: 400 });
    }

    const proceeds = sharesToSell * currentPrice;
    console.log('[PredictionClose] Success:', result.orderID, 'proceeds:', proceeds.toFixed(4));
    console.log('[PredictionClose] ═══════════════════════════════════');

    return NextResponse.json({
      success: true,
      orderID: result.orderID,
      status: result.status,
      market: market.question,
      outcome,
      shares: sharesToSell,
      price: currentPrice,
      proceeds,
    });
  } catch (err) {
    console.error('[PredictionClose] Unhandled:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
