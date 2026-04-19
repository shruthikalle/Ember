/**
 * GET /api/birdeye/price?address={mint}
 *
 * Returns the current USD price for a given Solana token.
 * Uses Birdeye /defi/price endpoint.
 */

import { NextResponse } from 'next/server';

const BIRDEYE = 'https://public-api.birdeye.so';

async function fetchT(url: string, opts: RequestInit = {}, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json({ error: 'address required' }, { status: 400 });
  }

  const key = process.env.BIRDEYE_API_KEY ?? '';
  if (!key) {
    return NextResponse.json({ error: 'No Birdeye API key' }, { status: 500 });
  }

  try {
    const res = await fetchT(
      `${BIRDEYE}/defi/price?address=${address}`,
      { headers: { 'X-API-KEY': key, 'x-chain': 'solana' } },
    );

    if (!res.ok) {
      return NextResponse.json({ error: `Birdeye HTTP ${res.status}` }, { status: res.status });
    }

    const json = await res.json();
    const price: number = json?.data?.value ?? 0;

    return NextResponse.json(
      { price, address },
      { headers: { 'Cache-Control': 's-maxage=15, stale-while-revalidate=30' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch price' },
      { status: 500 },
    );
  }
}
