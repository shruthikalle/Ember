/**
 * GET /api/yields
 *
 * Returns the top USDC lending yields on Base, sourced from DeFi Llama's
 * public /pools endpoint. Filters for liquid stablecoin pools on recognized
 * blue-chip lending protocols and returns the top 10 by APY.
 *
 * Response is cached for 5 minutes via Next.js ISR (revalidate = 300).
 */

import { NextResponse } from 'next/server';

export const revalidate = 300;

const DEFILLAMA_POOLS_URL = 'https://yields.llama.fi/pools';

const ALLOWED_PROJECTS = new Set<string>([
  'aave-v3',
  'morpho-blue',
  'fluid-lending',
  'compound-v3',
  'spark',
  'moonwell',
]);

const MIN_TVL_USD = 1_000_000;
const MAX_RESULTS = 10;

interface LlamaPool {
  pool: string;
  project: string;
  symbol: string;
  chain: string;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number | null;
  stablecoin: boolean;
}

interface LlamaResponse {
  status?: string;
  data?: LlamaPool[];
}

interface YieldPool {
  pool: string;
  project: string;
  symbol: string;
  apy: number;
  apyBase: number;
  apyReward: number;
  tvlUsd: number;
  chain: string;
  url: string;
}

function normalizeSymbol(symbol: string | undefined | null): string {
  return (symbol ?? '').toUpperCase();
}

function isNativeUsdcSymbol(symbolUpper: string): boolean {
  if (!symbolUpper.includes('USDC')) return false;
  // Reject bridged / wrapped variants so we surface the cleanest pools.
  if (symbolUpper.includes('USDC.E')) return false;
  if (symbolUpper.includes('USDBC')) return false;
  return true;
}

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(DEFILLAMA_POOLS_URL, {
      headers: { accept: 'application/json' },
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `DeFi Llama returned ${res.status}` },
        { status: 503 },
      );
    }

    const payload = (await res.json()) as LlamaResponse;
    const rows = Array.isArray(payload?.data) ? payload.data : [];

    const filtered: YieldPool[] = rows
      .filter((p): p is LlamaPool => !!p && typeof p === 'object')
      .filter((p) => p.chain === 'Base')
      .filter((p) => p.stablecoin === true)
      .filter((p) => typeof p.tvlUsd === 'number' && (p.tvlUsd ?? 0) >= MIN_TVL_USD)
      .filter((p) => typeof p.project === 'string' && ALLOWED_PROJECTS.has(p.project))
      .filter((p) => isNativeUsdcSymbol(normalizeSymbol(p.symbol)))
      .filter((p) => typeof p.apy === 'number' && Number.isFinite(p.apy))
      .map<YieldPool>((p) => ({
        pool: p.pool,
        project: p.project,
        symbol: p.symbol,
        apy: p.apy ?? 0,
        apyBase: typeof p.apyBase === 'number' ? p.apyBase : 0,
        apyReward: typeof p.apyReward === 'number' ? p.apyReward : 0,
        tvlUsd: p.tvlUsd ?? 0,
        chain: p.chain,
        url: `https://defillama.com/yields/pool/${p.pool}`,
      }))
      .sort((a, b) => b.apy - a.apy)
      .slice(0, MAX_RESULTS);

    return NextResponse.json({
      pools: filtered,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json(
      { error: `Failed to fetch yields: ${message}` },
      { status: 503 },
    );
  }
}
