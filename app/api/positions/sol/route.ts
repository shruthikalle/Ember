/**
 * GET /api/positions/sol
 *
 * Read-only placeholder for Solana positions. Ember's wallet is EVM-only,
 * so we never hold or execute against a SOL stake on the user's behalf.
 * This route instead surfaces the best live staking rate (from /api/yields-sol)
 * so the UI can deep link the user out to the protocol's own staking site.
 *
 * Query params:
 *   address  — optional, ignored (kept for API symmetry)
 *
 * Response:
 *   {
 *     positions: [],
 *     bestRate: { protocol, apy, protocolUrl } | null,
 *     readOnly: true,
 *     note: string
 *   }
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { SolPool } from '@/src/lib/sol-yields';

interface BestRate {
  protocol: string;
  apy: number;
  protocolUrl: string;
}

interface YieldsSolResponse {
  pools?: SolPool[];
  error?: string;
}

const NOTE =
  'SOL staking is handled on each protocol\u2019s own site. Click Stake to open it.';

async function fetchBestRate(request: NextRequest): Promise<BestRate | null> {
  try {
    const url = new URL('/api/yields-sol', request.url);
    const res = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
      // Honor the downstream route's own ISR cache.
      next: { revalidate: 300 },
    });

    if (!res.ok) return null;

    const payload = (await res.json()) as YieldsSolResponse;
    const pools = Array.isArray(payload?.pools) ? payload.pools : [];
    if (pools.length === 0) return null;

    const top = pools[0];
    if (!top || typeof top.apy !== 'number' || !Number.isFinite(top.apy)) {
      return null;
    }

    return {
      protocol: top.displayName || top.project,
      apy: top.apy,
      protocolUrl: top.protocolUrl,
    };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const bestRate = await fetchBestRate(request);

  return NextResponse.json({
    positions: [],
    bestRate,
    readOnly: true,
    note: NOTE,
  });
}
