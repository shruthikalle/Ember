/**
 * GET /api/birdeye/whales?address=<mint>&limit=<n>
 *
 * Fetches recent swap transactions for a Solana token and filters for
 * whale-size trades (>= $5,000 USD). Returns a normalised array of
 * whale transactions with a human-readable "timeAgo" field.
 *
 * Falls back to 5 mock whale transactions if the API call fails or no
 * whales are found in the returned window.
 *
 * Cache: s-maxage=30
 */

import { NextRequest, NextResponse } from 'next/server';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const WHALE_THRESHOLD_USD = 5_000;

interface WhaleTx {
  txHash: string;
  side: 'buy' | 'sell';
  amountUSD: number;
  amountToken: number;
  price: number;
  walletAddress: string;
  blockTime: number;
  timeAgo: string;
}

// Raw transaction shape returned by Birdeye /defi/txs/token
interface BirdeyeRawTx {
  txHash?: string;
  signature?: string;
  side?: string;
  volumeUSD?: number;
  volume?: number;
  tokenAmount?: number;
  amount?: number;
  price?: number;
  from?: { symbol?: string; address?: string };
  owner?: string;
  source?: string;
  blockUnixTime?: number;
  blockTime?: number;
}

function formatTimeAgo(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
  return `${Math.floor(diffSecs / 86400)}d ago`;
}

function normaliseTx(raw: BirdeyeRawTx): WhaleTx | null {
  const amountUSD = raw.volumeUSD ?? raw.volume ?? 0;
  if (amountUSD < WHALE_THRESHOLD_USD) return null;

  const blockTime = raw.blockUnixTime ?? raw.blockTime ?? 0;
  const fromSymbol = raw.from?.symbol ?? '';
  const side: 'buy' | 'sell' = fromSymbol.toUpperCase() === 'SOL' ? 'buy' : 'sell';

  return {
    txHash: raw.txHash ?? raw.signature ?? '',
    side,
    amountUSD,
    amountToken: raw.tokenAmount ?? raw.amount ?? 0,
    price: raw.price ?? 0,
    walletAddress: raw.owner ?? raw.source ?? raw.from?.address ?? '',
    blockTime,
    timeAgo: blockTime ? formatTimeAgo(blockTime) : 'unknown',
  };
}

function buildMockWhales(address: string): WhaleTx[] {
  const now = Math.floor(Date.now() / 1000);
  const seed = address.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);

  return [
    {
      txHash: `mock${seed.toString(16)}aa`,
      side: 'buy',
      amountUSD: 45_000,
      amountToken: 24_064,
      price: 1.87,
      walletAddress: `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`,
      blockTime: now - 120,
      timeAgo: '2m ago',
    },
    {
      txHash: `mock${seed.toString(16)}bb`,
      side: 'sell',
      amountUSD: 28_500,
      amountToken: 15_240,
      price: 1.87,
      walletAddress: `9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`,
      blockTime: now - 480,
      timeAgo: '8m ago',
    },
    {
      txHash: `mock${seed.toString(16)}cc`,
      side: 'buy',
      amountUSD: 92_000,
      amountToken: 49_197,
      price: 1.87,
      walletAddress: `Fz6LxeUg5qjesYX3BdmtTwyyzBtMxk644LoA8uGtseA5`,
      blockTime: now - 900,
      timeAgo: '15m ago',
    },
    {
      txHash: `mock${seed.toString(16)}dd`,
      side: 'buy',
      amountUSD: 11_200,
      amountToken: 5_989,
      price: 1.87,
      walletAddress: `3h1zGmCwsRJnVk5BuRNMLsPaQu1y2aqXqXDWYCgrp5UG`,
      blockTime: now - 1_800,
      timeAgo: '30m ago',
    },
    {
      txHash: `mock${seed.toString(16)}ee`,
      side: 'sell',
      amountUSD: 67_300,
      amountToken: 35_989,
      price: 1.87,
      walletAddress: `BYxEJTDerEictU3dL5LfTpADPMqnmada7WNtresEFHXN`,
      blockTime: now - 3_600,
      timeAgo: '1h ago',
    },
  ];
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;

  if (!address) {
    return NextResponse.json(
      { error: 'Query parameter "address" is required' },
      { status: 400 },
    );
  }

  const key = process.env.BIRDEYE_API_KEY;

  if (!key) {
    console.warn('[Birdeye/whales] BIRDEYE_API_KEY not set — returning mock data');
    return NextResponse.json(
      { whales: buildMockWhales(address), source: 'mock' },
      { headers: { 'Cache-Control': 's-maxage=30' } },
    );
  }

  try {
    const url =
      `${BIRDEYE_BASE}/defi/txs/token` +
      `?address=${address}&tx_type=swap&sort_type=desc&limit=${limit}&chain=solana`;

    const res = await fetch(url, {
      headers: {
        'X-API-KEY': key,
        'x-chain': 'solana',
      },
    });

    if (!res.ok) {
      throw new Error(`Birdeye responded ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    const rawTxs: BirdeyeRawTx[] = json?.data?.items ?? json?.data?.txs ?? json?.data ?? [];

    const whales = rawTxs
      .map(normaliseTx)
      .filter((tx): tx is WhaleTx => tx !== null);

    console.log(`[Birdeye/whales] ${address} — ${rawTxs.length} txs, ${whales.length} whales (>=$${WHALE_THRESHOLD_USD})`);

    if (whales.length === 0) {
      console.warn('[Birdeye/whales] No whale transactions found — returning mock data');
      return NextResponse.json(
        { whales: buildMockWhales(address), source: 'mock' },
        { headers: { 'Cache-Control': 's-maxage=30' } },
      );
    }

    return NextResponse.json(
      { whales, source: 'birdeye' },
      { headers: { 'Cache-Control': 's-maxage=30' } },
    );
  } catch (err) {
    console.error('[Birdeye/whales] API error — falling back to mock:', err instanceof Error ? err.message : err);

    return NextResponse.json(
      { whales: buildMockWhales(address), source: 'mock' },
      { headers: { 'Cache-Control': 's-maxage=30' } },
    );
  }
}
