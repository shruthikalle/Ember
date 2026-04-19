/**
 * POST /api/solana/token-balance
 * Body: { wallet: string, mint: string }
 * Returns: { balance: number, decimals: number, rawAmount: string }
 *
 * Fetches the actual on-chain SPL token balance for a wallet + mint address.
 * Used by the sell modal to get the real balance instead of relying on localStorage.
 */

import { NextResponse } from 'next/server';

const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
];

async function rpcCall(method: string, params: unknown[], ms = 5000) {
  for (const endpoint of RPC_ENDPOINTS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.error) continue;
      return json.result;
    } catch {
      clearTimeout(t);
    }
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const { wallet, mint } = await req.json();
    if (!wallet || !mint) {
      return NextResponse.json({ error: 'wallet and mint required' }, { status: 400 });
    }

    const result = await rpcCall('getTokenAccountsByOwner', [
      wallet,
      { mint },
      { encoding: 'jsonParsed' },
    ]);

    if (!result) {
      return NextResponse.json({ balance: 0, decimals: 6, rawAmount: '0' });
    }

    const accounts: any[] = result.value ?? [];
    if (accounts.length === 0) {
      return NextResponse.json({ balance: 0, decimals: 6, rawAmount: '0' });
    }

    // Sum across all token accounts for this mint (usually just one)
    let totalRaw = BigInt(0);
    let decimals = 6;

    for (const acc of accounts) {
      const info = acc?.account?.data?.parsed?.info?.tokenAmount;
      if (!info) continue;
      decimals = info.decimals ?? 6;
      totalRaw += BigInt(info.amount ?? '0');
    }

    const balance = Number(totalRaw) / Math.pow(10, decimals);

    return NextResponse.json({ balance, decimals, rawAmount: totalRaw.toString() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed', balance: 0, decimals: 6 },
      { status: 500 },
    );
  }
}
