/**
 * GET /api/birdeye/security?address=<mint>
 *
 * Fetches token security metrics and overview data for a Solana token,
 * merges them into a single object, and computes a risk score (0-100,
 * higher = healthier) plus a directional signal.
 *
 * Falls back to plausible mock data if the address is valid but the
 * upstream API call fails.
 *
 * Cache: s-maxage=120
 */

import { NextRequest, NextResponse } from 'next/server';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

interface SecurityResponse {
  ownershipPercentage: number;
  creatorPercentage: number;
  top10HolderPercent: number;
  lpBurnedPercent: number;
  price: number;
  priceChange24hPercent: number;
  volume24hUSD: number;
  marketcap: number;
  holder: number;
  riskScore: number;
  signal: 'bullish' | 'bearish' | 'neutral';
}

function computeRiskScore(
  lpBurnedPercent: number,
  top10HolderPercent: number,
  creatorPercentage: number,
): number {
  let score = 50;

  if (lpBurnedPercent === 100) {
    score += 20;
  } else if (lpBurnedPercent > 80) {
    score += 10;
  }

  if (top10HolderPercent < 20) {
    score += 15;
  } else if (top10HolderPercent > 50) {
    score -= 20;
  }

  if (creatorPercentage < 1) {
    score += 10;
  } else if (creatorPercentage > 5) {
    score -= 20;
  }

  return Math.max(0, Math.min(100, score));
}

function deriveSignal(score: number): 'bullish' | 'bearish' | 'neutral' {
  if (score > 65) return 'bullish';
  if (score < 40) return 'bearish';
  return 'neutral';
}

function buildMockResponse(address: string): SecurityResponse {
  // Seed a pseudo-random value from the address so the same address always
  // returns the same mock data within a session.
  const seed =
    address.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 100;

  const lpBurnedPercent = seed > 60 ? 100 : seed;
  const top10HolderPercent = 15 + (seed % 40);
  const creatorPercentage = seed % 8;

  const riskScore = computeRiskScore(lpBurnedPercent, top10HolderPercent, creatorPercentage);

  return {
    ownershipPercentage: top10HolderPercent,
    creatorPercentage,
    top10HolderPercent,
    lpBurnedPercent,
    price: parseFloat((0.001 + (seed / 1000)).toFixed(6)),
    priceChange24hPercent: parseFloat(((seed - 50) / 5).toFixed(2)),
    volume24hUSD: 100_000 + seed * 50_000,
    marketcap: 1_000_000 + seed * 200_000,
    holder: 500 + seed * 100,
    riskScore,
    signal: deriveSignal(riskScore),
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json(
      { error: 'Query parameter "address" is required' },
      { status: 400 },
    );
  }

  const key = process.env.BIRDEYE_API_KEY;

  if (!key) {
    console.warn('[Birdeye/security] BIRDEYE_API_KEY not set — returning mock data');
    return NextResponse.json(
      { ...buildMockResponse(address), source: 'mock' },
      {
        headers: { 'Cache-Control': 's-maxage=120' },
      },
    );
  }

  const headers = {
    'X-API-KEY': key,
    'x-chain': 'solana',
  };

  try {
    const [securityRes, overviewRes] = await Promise.all([
      fetch(`${BIRDEYE_BASE}/defi/token_security?address=${address}`, { headers }),
      fetch(`${BIRDEYE_BASE}/defi/token_overview?address=${address}`, { headers }),
    ]);

    if (!securityRes.ok) {
      throw new Error(`token_security responded ${securityRes.status}: ${securityRes.statusText}`);
    }
    if (!overviewRes.ok) {
      throw new Error(`token_overview responded ${overviewRes.status}: ${overviewRes.statusText}`);
    }

    const [securityJson, overviewJson] = await Promise.all([
      securityRes.json(),
      overviewRes.json(),
    ]);

    const sec = securityJson?.data ?? {};
    const ov = overviewJson?.data ?? {};

    const top10HolderPercent: number = sec.top10HolderPercent ?? 0;
    const creatorPercentage: number = sec.creatorPercentage ?? sec.creatorPercent ?? 0;
    const lpBurnedPercent: number = sec.lpBurnedPercent ?? sec.liquidityBurnedPercent ?? 0;
    const ownershipPercentage: number = sec.ownershipPercentage ?? top10HolderPercent;

    const riskScore = computeRiskScore(lpBurnedPercent, top10HolderPercent, creatorPercentage);

    const response: SecurityResponse = {
      ownershipPercentage,
      creatorPercentage,
      top10HolderPercent,
      lpBurnedPercent,
      price: ov.price ?? 0,
      priceChange24hPercent: ov.priceChange24hPercent ?? 0,
      volume24hUSD: ov.volume24hUSD ?? ov.v24hUSD ?? 0,
      marketcap: ov.marketcap ?? ov.mc ?? 0,
      holder: ov.holder ?? ov.holderCount ?? 0,
      riskScore,
      signal: deriveSignal(riskScore),
    };

    console.log(`[Birdeye/security] ${address} — score: ${riskScore}, signal: ${response.signal}`);

    return NextResponse.json(
      { ...response, source: 'birdeye' },
      {
        headers: { 'Cache-Control': 's-maxage=120' },
      },
    );
  } catch (err) {
    console.error('[Birdeye/security] API error — falling back to mock:', err instanceof Error ? err.message : err);

    return NextResponse.json(
      { ...buildMockResponse(address), source: 'mock' },
      {
        headers: { 'Cache-Control': 's-maxage=120' },
      },
    );
  }
}
