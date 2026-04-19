/**
 * POST /api/predictions/trade/auth
 *
 * Derive Polymarket CLOB API credentials from a signed auth message.
 * Client stores the returned creds in localStorage per wallet address.
 *
 * Body: { address, signature, timestamp, nonce }
 */

import { NextRequest, NextResponse } from 'next/server';
import { deriveApiKey } from '@/src/lib/polymarket-clob';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address, signature, timestamp, nonce } = body as {
      address: string;
      signature: string;
      timestamp: string;
      nonce: number;
    };

    if (!address || !signature || !timestamp || nonce === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: address, signature, timestamp, nonce' },
        { status: 400 },
      );
    }

    console.log('[PredictionAuth] Deriving API key for:', address);

    const creds = await deriveApiKey({ address, signature, timestamp, nonce });

    console.log('[PredictionAuth] API key derived successfully');

    return NextResponse.json({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiPassphrase: creds.apiPassphrase,
    });
  } catch (err) {
    console.error('[PredictionAuth] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to derive API key' },
      { status: 500 },
    );
  }
}
