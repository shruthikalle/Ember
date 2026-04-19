/**
 * GET /api/positions/eth?address=0x...
 *
 * Aggregates a user's ETH-denominated lending positions across:
 *   - Lido stETH (Ethereum mainnet)
 *   - Aave v3 WETH (Base)
 *   - Compound v3 WETH (Base)
 *
 * Also computes the current best available ETH yield across these three
 * protocols so the UI can surface it as a "best rate" suggestion.
 *
 * Never throws for a single protocol outage — each fetcher defaults to 0 /
 * fallback APY so the route returns a consistent shape.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getLidoStEthBalance, getLidoApr } from '../../../../src/lib/lido';
import {
  getAaveWethBalance,
  getCompoundWethBalance,
  getAaveWethSupplyApy,
  getCompoundWethSupplyApy,
} from '../../../../src/lib/weth-lending';

export const dynamic = 'force-dynamic';

interface Position {
  protocol: string;
  suppliedEth: number;
  apy: number;
  chain: 'ethereum' | 'base';
}

interface BestRate {
  protocol: string;
  apy: number;
  chain: string;
}

function isHexAddress(value: string | null): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

async function safeNumber(p: Promise<number>): Promise<number> {
  try {
    const v = await p;
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const address = req.nextUrl.searchParams.get('address');
  if (!isHexAddress(address)) {
    return NextResponse.json(
      { error: 'Missing or invalid address query param' },
      { status: 400 },
    );
  }

  const [
    lidoBalance,
    aaveBalance,
    compoundBalance,
    lidoApr,
    aaveApy,
    compoundApy,
  ] = await Promise.all([
    safeNumber(getLidoStEthBalance(address)),
    safeNumber(getAaveWethBalance(address)),
    safeNumber(getCompoundWethBalance(address)),
    safeNumber(getLidoApr()),
    safeNumber(getAaveWethSupplyApy()),
    safeNumber(getCompoundWethSupplyApy()),
  ]);

  const positions: Position[] = [];
  if (lidoBalance > 0) {
    positions.push({
      protocol: 'Lido',
      suppliedEth: lidoBalance,
      apy: lidoApr,
      chain: 'ethereum',
    });
  }
  if (aaveBalance > 0) {
    positions.push({
      protocol: 'Aave v3',
      suppliedEth: aaveBalance,
      apy: aaveApy,
      chain: 'base',
    });
  }
  if (compoundBalance > 0) {
    positions.push({
      protocol: 'Compound v3',
      suppliedEth: compoundBalance,
      apy: compoundApy,
      chain: 'base',
    });
  }

  const candidates: BestRate[] = [
    { protocol: 'Lido', apy: lidoApr, chain: 'ethereum' },
    { protocol: 'Aave v3', apy: aaveApy, chain: 'base' },
    { protocol: 'Compound v3', apy: compoundApy, chain: 'base' },
  ].filter((c) => Number.isFinite(c.apy) && c.apy > 0);

  let bestRate: BestRate | null = null;
  for (const c of candidates) {
    if (!bestRate || c.apy > bestRate.apy) {
      bestRate = c;
    }
  }

  return NextResponse.json({ positions, bestRate });
}
