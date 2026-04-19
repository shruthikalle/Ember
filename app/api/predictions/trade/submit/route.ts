/**
 * POST /api/predictions/trade/submit
 *
 * Submit a signed Polymarket order to the CLOB.
 * Uses server-side API credentials from env vars.
 *
 * Body: { trade_id, orderMessage, signature, owner }
 */

import { NextRequest, NextResponse } from 'next/server';
import { submitOrder } from '@/src/lib/polymarket-clob';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { trade_id, orderMessage, signature, owner } = body as {
      trade_id: string;
      orderMessage: any;
      signature: string;
      owner: string;
    };

    if (!trade_id || !orderMessage || !signature) {
      return NextResponse.json(
        { error: 'Missing required fields: trade_id, orderMessage, signature' },
        { status: 400 },
      );
    }

    // Use server-side CLOB credentials
    const apiKey = process.env.POLYMARKET_CLOB_API_KEY;
    const apiSecret = process.env.POLYMARKET_CLOB_SECRET;
    const apiPassphrase = process.env.POLYMARKET_CLOB_PASSPHRASE;

    if (!apiKey || !apiSecret || !apiPassphrase) {
      return NextResponse.json(
        { error: 'Polymarket CLOB API credentials not configured on server' },
        { status: 500 },
      );
    }

    const creds = { apiKey, apiSecret, apiPassphrase };

    console.log('[PredictionSubmit] Submitting order for trade:', trade_id);
    console.log('[PredictionSubmit] Order maker:', orderMessage.maker);
    console.log('[PredictionSubmit] Token ID:', orderMessage.tokenId);
    console.log('[PredictionSubmit] Side:', orderMessage.side);

    const result = await submitOrder({
      order: orderMessage,
      signature,
      creds,
      owner: owner || orderMessage.maker,
      orderType: 'FOK',
    });

    if (!result.success) {
      console.error('[PredictionSubmit] Order failed:', result.errorMsg);
      return NextResponse.json(
        { error: result.errorMsg || 'Order submission failed' },
        { status: 400 },
      );
    }

    console.log('[PredictionSubmit] Order result:', result);

    return NextResponse.json({
      success: true,
      trade_id,
      orderID: result.orderID,
      transactID: result.transactID,
      status: result.status,
    });
  } catch (err) {
    console.error('[PredictionSubmit] Unhandled error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
