/**
 * GET /api/predictions/positions
 *
 * List the user's current open positions on Polymarket.
 * Uses Polymarket's public data API (data-api.polymarket.com) keyed by the
 * funder wallet — which is the proxy address when POLY_ADDRESS is set, or
 * the signer's EOA otherwise.
 *
 * Optional query:
 *   ?address=0x…   override the wallet to inspect (useful for multi-user)
 *   ?sizeThreshold=0.01  filter out dust (default 0.01 shares)
 *
 * Response: { positions: [...] } with the raw Polymarket fields plus a tidied
 * subset the UI uses directly.
 */

import { NextRequest, NextResponse } from 'next/server';

const DATA_API = 'https://data-api.polymarket.com';

interface PolymarketPosition {
  proxyWallet: string;
  asset: string;                 // tokenId of the share we hold
  conditionId: string;
  size: number;                  // shares held
  avgPrice: number;              // avg fill price 0..1
  initialValue: number;          // amount paid
  currentValue: number;          // mark-to-market
  cashPnl: number;               // currentValue - initialValue
  percentPnl: number;
  curPrice: number;              // last mid / quote
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventId: string;
  eventSlug: string;
  outcome: string;               // "Yes" | "No"
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const explicit = searchParams.get('address');
    const sizeThreshold = searchParams.get('sizeThreshold') || '0.01';

    // Default to the env-configured funder (proxy if set, EOA otherwise).
    const address =
      explicit ||
      process.env.POLY_ADDRESS ||
      process.env.POLYMARKET_FUNDER_ADDRESS ||
      null;

    if (!address) {
      return NextResponse.json(
        { error: 'No wallet address configured. Set POLY_ADDRESS in .env or pass ?address=.' },
        { status: 400 },
      );
    }

    const url = `${DATA_API}/positions?user=${address.toLowerCase()}&limit=100&sizeThreshold=${sizeThreshold}`;
    const res = await fetch(url, { cache: 'no-store' });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Polymarket data API returned ${res.status}` },
        { status: 502 },
      );
    }

    const raw = (await res.json()) as PolymarketPosition[];

    // Tidy for the UI; keep the asset field (we need it for the SELL order).
    const positions = raw.map((p) => ({
      title: p.title,
      slug: p.slug,
      icon: p.icon,
      eventSlug: p.eventSlug,
      outcome: p.outcome,                              // "Yes" | "No"
      outcomeIndex: p.outcomeIndex,
      tokenId: p.asset,                                // needed for SELL
      oppositeTokenId: p.oppositeAsset,
      conditionId: p.conditionId,
      negRisk: p.negativeRisk,
      shares: p.size,
      avgPrice: p.avgPrice,
      currentPrice: p.curPrice,
      initialValue: p.initialValue,
      currentValue: p.currentValue,
      pnl: p.cashPnl,
      pnlPct: p.percentPnl,
      endDate: p.endDate,
      redeemable: p.redeemable,                        // true when market resolved
    }));

    return NextResponse.json({
      address,
      count: positions.length,
      positions,
    });
  } catch (err) {
    console.error('[Positions] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
