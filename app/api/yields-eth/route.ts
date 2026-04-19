/**
 * GET /api/yields-eth
 *
 * Returns the top ETH-denominated yields on Ethereum mainnet and Base,
 * sourced from DeFi Llama's public /pools endpoint. Filters for established
 * blue-chip ETH liquid staking and WETH lending protocols, returning the
 * top 10 by APY.
 *
 * Response is cached for 5 minutes via Next.js ISR (revalidate = 300).
 */

import { NextResponse } from 'next/server';

export const revalidate = 300;

const DEFILLAMA_POOLS_URL = 'https://yields.llama.fi/pools';

const ALLOWED_PROJECTS = new Set<string>([
  'lido',
  'rocket-pool',
  'coinbase-wrapped-staked-eth',
  'aave-v3',
  'morpho-blue',
  'compound-v3',
  'spark',
]);

const ALLOWED_CHAINS = new Set<string>(['Ethereum', 'Base']);

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

function isEthSymbol(symbolUpper: string): boolean {
  // Must contain "ETH" somewhere (matches ETH, WETH, stETH, rETH, cbETH, etc.)
  return symbolUpper.includes('ETH');
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
      .filter((p) => typeof p.chain === 'string' && ALLOWED_CHAINS.has(p.chain))
      .filter((p) => !p.stablecoin)
      .filter((p) => typeof p.tvlUsd === 'number' && (p.tvlUsd ?? 0) >= MIN_TVL_USD)
      .filter((p) => typeof p.project === 'string' && ALLOWED_PROJECTS.has(p.project))
      .filter((p) => isEthSymbol(normalizeSymbol(p.symbol)))
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
