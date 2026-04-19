/**
 * GET /api/birdeye/trending
 *
 * Returns REAL pump.fun tokens (addresses ending in 'pump') that are trending
 * with rising 24h price, sorted by volume.
 *
 * Strategy:
 *  1. DexScreener /token-profiles/latest/v1 → latest pump.fun token addresses
 *  2. DexScreener /token-boosts/top/v1      → boosted/promoted pump.fun tokens
 *  3. Batch lookup pair data from DexScreener → volume, price change, market cap, images
 *  4. Enrich with Birdeye token_overview     → more accurate price/holder data
 *  5. Filter: priceChange24h > 0, sort: volume desc
 *
 * Cache: s-maxage=45, stale-while-revalidate=90
 */

import { NextResponse } from 'next/server';

const DEXSCREENER = 'https://api.dexscreener.com';
const BIRDEYE     = 'https://public-api.birdeye.so';

export interface MemeToken {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24hPercent: number;
  volume24hUSD: number;
  volume24hChangePercent: number;
  marketcap: number;
  logoURI: string;
  liquidity: number;
  holder: number;
}

async function fetchT(url: string, opts: RequestInit = {}, ms = 6000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// ─── Collect pump.fun token addresses ────────────────────────────────────────

async function getPumpAddresses(): Promise<string[]> {
  const seen = new Set<string>();
  const addrs: string[] = [];

  const add = (addr: string) => {
    if (addr && addr.toLowerCase().endsWith('pump') && !seen.has(addr)) {
      seen.add(addr);
      addrs.push(addr);
    }
  };

  // Source 1: latest token profiles (freshly launched pump.fun tokens)
  const [profilesRes, boostsRes] = await Promise.allSettled([
    fetchT(`${DEXSCREENER}/token-profiles/latest/v1`),
    fetchT(`${DEXSCREENER}/token-boosts/top/v1`),
  ]);

  if (profilesRes.status === 'fulfilled' && profilesRes.value.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await profilesRes.value.json();
    for (const t of data) {
      if (t.chainId === 'solana') add(t.tokenAddress ?? '');
    }
  }

  if (boostsRes.status === 'fulfilled' && boostsRes.value.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any[] = await boostsRes.value.json();
    for (const t of data) {
      if (t.chainId === 'solana') add(t.tokenAddress ?? '');
    }
  }

  return addrs.slice(0, 50); // cap at 50 for batch lookup
}

// ─── Batch pair lookup from DexScreener ──────────────────────────────────────

interface DexPair {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  logoURI: string;
}

async function getDexPairs(addresses: string[]): Promise<DexPair[]> {
  if (addresses.length === 0) return [];

  // DexScreener allows up to 30 addresses per batch
  const BATCH = 30;
  const results: DexPair[] = [];
  const byAddr = new Map<string, DexPair>();

  for (let i = 0; i < addresses.length; i += BATCH) {
    const slice = addresses.slice(i, i + BATCH);
    try {
      const res = await fetchT(
        `${DEXSCREENER}/latest/dex/tokens/${slice.join(',')}`,
        {},
        5000,
      );
      if (!res.ok) continue;
      const json = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pairs: any[] = json?.pairs ?? [];

      for (const p of pairs) {
        const base = p.baseToken ?? {};
        const addr: string = base.address ?? '';
        if (!addr.toLowerCase().endsWith('pump')) continue;

        const vol = parseFloat(p.volume?.h24 ?? '0') || 0;
        const existing = byAddr.get(addr);
        // Keep the pair with highest volume per token address
        if (existing && existing.volume24h >= vol) continue;

        byAddr.set(addr, {
          address:       addr,
          symbol:        (base.symbol ?? '').toUpperCase(),
          name:          base.name ?? '',
          price:         parseFloat(p.priceUsd ?? '0') || 0,
          priceChange24h: parseFloat(p.priceChange?.h24 ?? '0') || 0,
          volume24h:     vol,
          marketCap:     parseFloat(p.marketCap ?? '0') || parseFloat(p.fdv ?? '0') || 0,
          logoURI:       p.info?.imageUrl ?? '',
        });
      }
    } catch { /* skip batch */ }
  }

  results.push(...byAddr.values());
  return results;
}

// ─── Birdeye enrichment for holder count + liquidity ─────────────────────────

async function enrichWithBirdeye(
  tokens: DexPair[],
  key: string,
): Promise<Map<string, { holder: number; liquidity: number; volChange: number }>> {
  const map = new Map<string, { holder: number; liquidity: number; volChange: number }>();
  if (!key || tokens.length === 0) return map;

  const BATCH = 6;
  const promises: Promise<void>[] = [];

  for (let i = 0; i < Math.min(tokens.length, 30); i += BATCH) {
    const slice = tokens.slice(i, i + BATCH);
    promises.push((async () => {
      await Promise.all(slice.map(async (t) => {
        try {
          const r = await fetchT(
            `${BIRDEYE}/defi/token_overview?address=${t.address}`,
            { headers: { 'X-API-KEY': key, 'x-chain': 'solana' } },
            3000,
          );
          if (!r.ok) return;
          const j = await r.json();
          const d = j?.data ?? {};
          map.set(t.address, {
            holder:    d.holder    ?? 0,
            liquidity: d.liquidity ?? 0,
            volChange: d.v24hChangePercent ?? 0,
          });
        } catch { /* skip */ }
      }));
    })());
  }

  await Promise.race([Promise.all(promises), new Promise(r => setTimeout(r, 4000))]);
  return map;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function GET() {
  const key = process.env.BIRDEYE_API_KEY ?? '';

  // Step 1: collect pump.fun addresses
  const addresses = await getPumpAddresses();
  console.log(`[trending] found ${addresses.length} pump.fun addresses`);

  if (addresses.length === 0) {
    return NextResponse.json(
      { tokens: [], error: 'No pump.fun addresses found' },
      { headers: { 'Cache-Control': 's-maxage=30' } },
    );
  }

  // Step 2: get pair data from DexScreener
  const pairs = await getDexPairs(addresses);
  console.log(`[trending] got ${pairs.length} pairs from DexScreener`);

  // Step 3: enrich with Birdeye
  const birdeyeData = await enrichWithBirdeye(pairs, key);

  // Step 4: normalise + filter
  const SKIP_SYMBOLS = new Set(['SOL','WSOL','USDC','USDT','WBTC','WETH','BTC','ETH']);

  const tokens: MemeToken[] = pairs
    .filter(p => p.address && p.symbol && !SKIP_SYMBOLS.has(p.symbol))
    .filter(p => p.priceChange24h > 0)   // rising today
    .filter(p => p.volume24h > 0)         // has any real volume
    .map(p => {
      const be = birdeyeData.get(p.address);
      return {
        address:               p.address,
        symbol:                p.symbol,
        name:                  p.name,
        price:                 p.price,
        priceChange24hPercent: p.priceChange24h,
        volume24hUSD:          p.volume24h,
        volume24hChangePercent: be?.volChange ?? 0,
        marketcap:             p.marketCap,
        logoURI:               p.logoURI,
        liquidity:             be?.liquidity ?? 0,
        holder:                be?.holder    ?? 0,
      };
    })
    .sort((a, b) => b.volume24hUSD - a.volume24hUSD)
    .slice(0, 20);

  console.log(`[trending] returning ${tokens.length} pump.fun tokens`);

  return NextResponse.json(
    { tokens, source: 'pump.fun+dexscreener' },
    { headers: { 'Cache-Control': 's-maxage=45, stale-while-revalidate=90' } },
  );
}
