/**
 * GET /api/earn/usdc-chains
 *
 * Returns top USDC supply APYs across Ethereum mainnet, Base, Polygon, and
 * Solana — read directly from each protocol (Aave v3 / Compound v3 /
 * Moonwell on EVM via on-chain calls; Solend + Kamino on Solana via their
 * public APIs). Also returns the static gas-cost table used for break-even
 * math on the client.
 *
 * Cached for 60s — rates move slowly enough that hammering RPC on every
 * page refresh is wasteful.
 */

import { NextResponse } from 'next/server';
import { fetchAllChainUsdcApys } from '@/src/lib/earn/chainApys';

export const revalidate = 60;
export const runtime = 'nodejs';

export async function GET() {
  const chains = await fetchAllChainUsdcApys();
  return NextResponse.json({
    chains,
    updatedAt: Date.now(),
  });
}
