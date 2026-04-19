/**
 * GET /api/yields-sol
 *
 * Returns the top SOL-denominated staking yields, sourced from DeFi Llama's
 * public /pools endpoint. Filters to Solana liquid staking tokens (LSTs) and
 * native staking providers on an allow list, filters out LP pairs, then
 * returns the top 8 by APY.
 *
 * Because Ember is EVM-only, this endpoint is read-only: each pool carries a
 * `protocolUrl` deep link to the protocol's own staking UI so users can stake
 * directly from that site.
 *
 * Response is cached for 5 minutes via Next.js ISR (revalidate = 300).
 */

import { NextResponse } from 'next/server';
import {
  PROTOCOL_URLS,
  formatProtocolName,
  type SolPool,
} from '@/src/lib/sol-yields';

/**
 * Friendlier display names for DeFi Llama project slugs that are noisy
 * or ambiguous (e.g. 'jito-liquid-staking' -> 'Jito').
 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  'jito-liquid-staking': 'Jito',
  'marinade-liquid-staking': 'Marinade',
  'marinade-finance': 'Marinade',
  'marinade-native': 'Marinade Native',
  'binance-staked-sol': 'Binance Staked SOL',
  'sanctum-infinity': 'Sanctum Infinity',
};

export const revalidate = 300;

const DEFILLAMA_POOLS_URL = 'https://yields.llama.fi/pools';

const ALLOWED_PROJECTS = new Set<string>([
  // Canonical slugs from the task spec
  'jito',
  'marinade-finance',
  'marinade-native',
  'blazestake',
  'jpool',
  'sanctum-infinity',
  'binance-staked-sol',
  // DeFi Llama's current live slugs for the same protocols
  'jito-liquid-staking',
  'marinade-liquid-staking',
]);

const MIN_TVL_USD = 1_000_000;
const MAX_RESULTS = 8;

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

function normalizeSymbol(symbol: string | undefined | null): string {
  return (symbol ?? '').toUpperCase();
}

/**
 * Accept symbols that clearly represent SOL staking exposure and reject
 * pairs / wrappers we don't want on the rate board.
 */
function isSolStakingSymbol(symbolUpper: string): boolean {
  if (!symbolUpper.includes('SOL')) return false;
  // LP pairs show up as e.g. "USDC-SOL" or "SOL-JITOSOL" — skip those.
  if (symbolUpper.includes('-')) return false;
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
        { error: `DeFi Llama returned ${res.status}`, pools: [] },
        { status: 503 },
      );
    }

    const payload = (await res.json()) as LlamaResponse;
    const rows = Array.isArray(payload?.data) ? payload.data : [];

    const filtered: SolPool[] = rows
      .filter((p): p is LlamaPool => !!p && typeof p === 'object')
      .filter((p) => p.chain === 'Solana')
      .filter((p) => p.stablecoin === false)
      .filter((p) => typeof p.tvlUsd === 'number' && (p.tvlUsd ?? 0) >= MIN_TVL_USD)
      .filter((p) => typeof p.project === 'string' && ALLOWED_PROJECTS.has(p.project))
      .filter((p) => isSolStakingSymbol(normalizeSymbol(p.symbol)))
      .filter((p) => typeof p.apy === 'number' && Number.isFinite(p.apy))
      .map<SolPool>((p) => {
        const llamaUrl = `https://defillama.com/yields/pool/${p.pool}`;
        const protocolUrl = PROTOCOL_URLS[p.project] ?? llamaUrl;
        const displayName =
          DISPLAY_NAME_OVERRIDES[p.project] ?? formatProtocolName(p.project);
        return {
          pool: p.pool,
          project: p.project,
          displayName,
          symbol: normalizeSymbol(p.symbol),
          apy: p.apy ?? 0,
          apyBase: typeof p.apyBase === 'number' ? p.apyBase : 0,
          apyReward: typeof p.apyReward === 'number' ? p.apyReward : 0,
          tvlUsd: p.tvlUsd ?? 0,
          chain: p.chain,
          llamaUrl,
          protocolUrl,
        };
      })
      .sort((a, b) => b.apy - a.apy)
      .slice(0, MAX_RESULTS);

    return NextResponse.json({
      pools: filtered,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json(
      { error: `Failed to fetch SOL yields: ${message}`, pools: [] },
      { status: 503 },
    );
  }
}
