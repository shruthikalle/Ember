/**
 * POST /api/perps/info
 *
 * Proxy endpoint for Hyperliquid API calls.
 * Routes through QuickNode HyperCore if configured, otherwise uses public API.
 * This centralizes all Hyperliquid API calls through the backend.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserState, getUserSpotState, getUserOpenOrders } from '@/src/lib/hyperliquid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, user } = body;

    // Validate request
    if (!type) {
      return NextResponse.json(
        { error: 'Missing required field: type' },
        { status: 400 }
      );
    }

    // Route to appropriate handler based on type
    let result;
    
    switch (type) {
      case 'clearinghouseState':
        if (!user) {
          return NextResponse.json(
            { error: 'Missing required field: user' },
            { status: 400 }
          );
        }
        result = await getUserState(user);
        break;

      case 'spotClearinghouseState':
        if (!user) {
          return NextResponse.json(
            { error: 'Missing required field: user' },
            { status: 400 }
          );
        }
        result = await getUserSpotState(user);
        break;

      case 'openOrders':
        if (!user) {
          return NextResponse.json(
            { error: 'Missing required field: user' },
            { status: 400 }
          );
        }
        result = await getUserOpenOrders(user);
        break;

      default:
        // For other types, use the generic hlInfo function
        // Import it dynamically to avoid circular dependencies
        const { qnInfo } = await import('@/src/lib/quicknode-stream');
        result = await qnInfo(body);
        break;
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Perps Info API] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
