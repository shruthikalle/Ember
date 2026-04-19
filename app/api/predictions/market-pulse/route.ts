/**
 * GET /api/predictions/market-pulse
 *
 * "Why is this market moving?" — returns price deltas (1h/24h), recent trade
 * activity, and the top whale fills in the last 24h with each wallet's
 * aggregate ROI across all Polymarket positions.
 *
 * Query:
 *   ?slug=X              — resolve market by slug
 *   ?conditionId=X&tokenId=Y   — skip slug lookup if you already have these
 *   ?whaleLimit=5         — default 5
 *
 * Response: MarketPulse (see src/lib/predictions/market-pulse.ts)
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  getEventBySlug,
  getMarketBySlug,
  parseClobTokenIds,
  type PolymarketMarket,
} from '@/src/lib/polymarket';
import { getMarketPulse } from '@/src/lib/predictions/market-pulse';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const slug = searchParams.get('slug');
    let conditionId = searchParams.get('conditionId');
    let tokenId = searchParams.get('tokenId');
    const whaleLimit = Math.max(1, Math.min(10, Number(searchParams.get('whaleLimit')) || 5));

    // If slug passed, look up the market and derive conditionId + yes tokenId.
    if ((!conditionId || !tokenId) && slug) {
      let market: PolymarketMarket | null = await getMarketBySlug(slug);
      if (!market) {
        const event = await getEventBySlug(slug);
        if (event && event.markets.length > 0) market = event.markets[0];
      }
      if (!market) {
        return NextResponse.json({ error: `Market not found for slug "${slug}"` }, { status: 404 });
      }
      conditionId = market.conditionId;
      const tokens = parseClobTokenIds(market);
      if (tokens) tokenId = tokens.yes;
    }

    if (!conditionId || !tokenId) {
      return NextResponse.json(
        { error: 'Either `slug`, or both `conditionId` and `tokenId`, are required.' },
        { status: 400 },
      );
    }

    const pulse = await getMarketPulse({ conditionId, tokenId, whaleLimit });
    return NextResponse.json(pulse);
  } catch (err) {
    console.error('[MarketPulse] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
