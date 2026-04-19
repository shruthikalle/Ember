/**
 * GET /api/positions/usdc?address=0x...
 *
 * Cross-protocol USDC lending position snapshot on Base. Queries Aave v3,
 * Compound v3 and Moonwell in parallel, collects every non-zero supply, and
 * returns the best-available APY across all three. Partial failures degrade
 * to zeros rather than rejecting the request.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';
import {
  EXECUTABLE_USDC_PROTOCOLS,
  getAllExecutableUsdcAdapters,
  type ProtocolId,
} from '../../../../src/lib/protocols';

interface UsdcPosition {
  protocol: ProtocolId;
  suppliedUsdc: number;
  apy: number;
  chain: 'Base';
}

interface BestRate {
  protocol: ProtocolId;
  apy: number;
}

interface UsdcPositionsResponse {
  address: string;
  positions: UsdcPosition[];
  bestRate: BestRate | null;
  updatedAt: string;
}

async function safe<T>(p: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.warn(`[positions/usdc] ${label} failed:`, err);
    return fallback;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json(
      { error: 'Missing or invalid ?address query parameter' },
      { status: 400 },
    );
  }

  const normalized = ethers.getAddress(address);
  const adapters = getAllExecutableUsdcAdapters();

  // Query balance + APY for every executable protocol in parallel.
  const rows = await Promise.all(
    adapters.map(async (adapter) => {
      const [supplied, apy] = await Promise.all([
        safe(adapter.getSuppliedBalance(normalized), 0, `${adapter.id} balance`),
        safe(adapter.getSupplyApy(), 0, `${adapter.id} apy`),
      ]);
      return { id: adapter.id, supplied, apy };
    }),
  );

  const positions: UsdcPosition[] = rows
    .filter((r) => r.supplied > 0)
    .map((r) => ({
      protocol: r.id,
      suppliedUsdc: r.supplied,
      apy: r.apy,
      chain: 'Base' as const,
    }));

  // Best rate = top APY across ALL executable protocols, regardless of
  // whether the user currently has a position there.
  const sortedByApy = [...rows].sort((a, b) => b.apy - a.apy);
  const top = sortedByApy[0];
  const bestRate: BestRate | null =
    top && top.apy > 0 ? { protocol: top.id, apy: top.apy } : null;

  // Defensive fallback: if somehow no adapters loaded, surface a null bestRate
  // but keep the protocol enum available to the client.
  void EXECUTABLE_USDC_PROTOCOLS;

  const body: UsdcPositionsResponse = {
    address: normalized,
    positions,
    bestRate,
    updatedAt: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
