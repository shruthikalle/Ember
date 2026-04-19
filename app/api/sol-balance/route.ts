/**
 * GET /api/sol-balance?address=<base58>[&minUsd=<number>]
 *
 * Server-side proxy for Solana balance lookups. Returns:
 *   - native SOL balance (lamports)
 *   - ALL SPL + Token-2022 balances with metadata (symbol/name/logo) + USD value
 *   - back-compat USDC fields (`usdc`, `usdcRaw`)
 *
 * Public Solana RPCs reject browser-origin requests (CORS / 403), so the
 * portfolio calls this route instead of hitting RPC directly. Metadata is
 * pulled from Jupiter's strict token list (cached in-memory for 1h) and
 * prices from Jupiter Price v2.
 *
 * Dust filter: tokens with USD value below `minUsd` are dropped. Default 0.5.
 * Pass `?minUsd=0` to include everything (including unpriced tokens).
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function buildRpcList(): string[] {
  const list: string[] = [];
  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) {
    list.push(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`);
  }
  list.push(
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
    'https://rpc.ankr.com/solana',
  );
  return list;
}

async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${rpc} returned ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

// ── Jupiter token-list cache (module-scoped, 1h TTL) ─────────────
type TokenMeta = { symbol: string; name: string; logoURI?: string };
let tokenListCache: { at: number; map: Map<string, TokenMeta> } | null = null;

async function getTokenMetaMap(): Promise<Map<string, TokenMeta>> {
  const now = Date.now();
  if (tokenListCache && now - tokenListCache.at < 3_600_000) return tokenListCache.map;
  try {
    const res = await fetch('https://token.jup.ag/strict', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Jupiter token list ${res.status}`);
    const list: Array<{ address: string; symbol: string; name: string; logoURI?: string }> = await res.json();
    const map = new Map<string, TokenMeta>();
    for (const t of list) map.set(t.address, { symbol: t.symbol, name: t.name, logoURI: t.logoURI });
    tokenListCache = { at: now, map };
    return map;
  } catch (err) {
    console.warn('[sol-balance] token list fetch failed:', err instanceof Error ? err.message : err);
    return tokenListCache?.map ?? new Map();
  }
}

async function fetchPrices(mints: string[]): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map();
  const out = new Map<string, number>();
  // Jupiter Price v2 — batch in chunks of 100 to stay under URL length limits
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    try {
      const url = `https://api.jup.ag/price/v2?ids=${chunk.join(',')}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      const obj = data?.data ?? {};
      for (const mint of Object.keys(obj)) {
        const price = Number(obj[mint]?.price);
        if (Number.isFinite(price)) out.set(mint, price);
      }
    } catch (err) {
      console.warn('[sol-balance] price fetch failed:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}

type SolTokenRecord = {
  mint: string;
  symbol?: string;
  name?: string;
  logo?: string;
  amount: number;
  decimals: number;
  priceUsd?: number;
  usd?: number;
};

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address');
  if (!address) {
    return NextResponse.json({ error: 'Missing address query param' }, { status: 400 });
  }
  const minUsdParam = req.nextUrl.searchParams.get('minUsd');
  const minUsd = minUsdParam !== null && Number.isFinite(parseFloat(minUsdParam))
    ? Math.max(0, parseFloat(minUsdParam))
    : 0.5;

  const RPCS = buildRpcList();

  for (const rpc of RPCS) {
    try {
      const [solResult, splResult, t22Result] = await Promise.all([
        rpcCall(rpc, 'getBalance', [address]),
        rpcCall(rpc, 'getTokenAccountsByOwner', [
          address,
          { programId: TOKEN_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]),
        rpcCall(rpc, 'getTokenAccountsByOwner', [
          address,
          { programId: TOKEN_2022_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]).catch(() => ({ value: [] })),
      ]);

      const lamports = typeof solResult?.value === 'number' ? solResult.value : 0;

      // Aggregate by mint (same mint can live in multiple token accounts)
      const byMint = new Map<string, { mint: string; amount: number; decimals: number }>();
      const allAccounts = [
        ...(splResult?.value ?? []),
        ...(t22Result?.value ?? []),
      ];
      for (const acct of allAccounts) {
        const info = acct?.account?.data?.parsed?.info;
        const mint: string | undefined = info?.mint;
        const ta = info?.tokenAmount;
        if (!mint || !ta) continue;
        const decimals = Number(ta.decimals) || 0;
        const raw = parseInt(ta.amount ?? '0', 10);
        if (!Number.isFinite(raw) || raw <= 0) continue;
        const ui = typeof ta.uiAmount === 'number' ? ta.uiAmount : raw / Math.pow(10, decimals);
        if (!(ui > 0)) continue;
        const prev = byMint.get(mint);
        if (prev) prev.amount += ui;
        else byMint.set(mint, { mint, amount: ui, decimals });
      }

      const mints = Array.from(byMint.keys());
      const [metaMap, priceMap] = await Promise.all([
        getTokenMetaMap(),
        fetchPrices(mints),
      ]);

      const tokens: SolTokenRecord[] = Array.from(byMint.values()).map((t) => {
        const meta = metaMap.get(t.mint);
        const priceUsd = priceMap.get(t.mint);
        const usd = priceUsd !== undefined ? t.amount * priceUsd : undefined;
        return {
          mint: t.mint,
          symbol: meta?.symbol,
          name: meta?.name,
          logo: meta?.logoURI,
          amount: t.amount,
          decimals: t.decimals,
          priceUsd,
          usd,
        };
      });

      // Dust filter: hide unpriced tokens AND tokens below the USD threshold
      // (unless caller passes minUsd=0, in which case show everything)
      const filtered = tokens
        .filter((t) => {
          if (minUsd === 0) return true;
          return (t.usd ?? 0) >= minUsd;
        })
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

      // Back-compat: surface USDC flat fields from the full token list
      const usdcTok = tokens.find((t) => t.mint === USDC_MINT);
      const usdc = usdcTok?.amount ?? 0;
      const usdcRaw = Math.round(usdc * 1e6);

      const safeSource = rpc.replace(/api-key=[^&]+/, 'api-key=***');
      return NextResponse.json({
        address,
        sol: lamports / 1e9,
        lamports,
        usdc,
        usdcRaw,
        tokens: filtered,
        tokenCount: filtered.length,
        totalTokenCount: tokens.length,
        source: safeSource,
      });
    } catch (err) {
      console.warn('[sol-balance]', err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json(
    { address, error: 'All Solana RPCs failed' },
    { status: 502 },
  );
}
