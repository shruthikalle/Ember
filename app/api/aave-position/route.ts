/**
 * GET /api/aave-position?address=0x...
 *
 * Returns the caller's current Aave v3 USDC supply position on Base:
 * supplied amount (from aUSDC rebasing balance) plus current supply APY.
 * Failures on either sub-call degrade to zeros with a server log warning.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAaveUsdcBalance, getAaveUsdcSupplyApy } from '../../../src/lib/aave';

interface AavePositionResponse {
  address: string;
  suppliedUsdc: number;
  apy: number;
  chain: 'Base';
  protocol: 'Aave v3';
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

  const [balanceResult, apyResult] = await Promise.allSettled([
    getAaveUsdcBalance(normalized),
    getAaveUsdcSupplyApy(),
  ]);

  let suppliedUsdc = 0;
  let apy = 0;

  if (balanceResult.status === 'fulfilled') {
    suppliedUsdc = balanceResult.value;
  } else {
    console.warn('[aave-position] balance lookup failed:', balanceResult.reason);
  }

  if (apyResult.status === 'fulfilled') {
    apy = apyResult.value;
  } else {
    console.warn('[aave-position] apy lookup failed:', apyResult.reason);
  }

  const body: AavePositionResponse = {
    address: normalized,
    suppliedUsdc,
    apy,
    chain: 'Base',
    protocol: 'Aave v3',
  };

  return NextResponse.json(body);
}
