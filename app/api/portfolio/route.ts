/**
 * GET /api/portfolio?evm=<0x...>&sol=<base58>[&minUsd=<number>]
 *
 * Unified multi-chain portfolio lookup. Returns native + stablecoin
 * balances for Ethereum mainnet, Base, Polygon, HyperEVM, and the full
 * SPL + Token-2022 list for Solana — each priced in USD where possible.
 *
 * Both `evm` and `sol` are optional; pass whichever addresses the user has
 * connected. At least one is required.
 *
 * Dust filter (Solana only): tokens with USD value < `minUsd` are dropped.
 * Default 0.5. Pass `?minUsd=0` to include everything.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ─── Constants ─────────────────────────────────────────────────

const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Fallback metadata + price for common SPL stables. Jupiter's token list /
// price endpoints are sometimes unreachable from the server region — these
// anchors keep canonical stables from silently disappearing when that happens.
const KNOWN_SPL_META: Record<string, { symbol: string; name: string; priceUsd: number }> = {
  [SOL_USDC_MINT]: { symbol: 'USDC', name: 'USD Coin',  priceUsd: 1 },
  [SOL_USDT_MINT]: { symbol: 'USDT', name: 'Tether USD', priceUsd: 1 },
};

// Build RPC lists with optional env-var overrides (server-only first so a
// private Alchemy/Infura key isn't exposed client-side; NEXT_PUBLIC_ as
// secondary; then curated public fallbacks).
// Order matters — the first RPC that clears the chainId probe AND returns
// a successful getBalance wins.
function envRpcs(...names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (v && typeof v === 'string') out.push(v);
  }
  return out;
}

const MAINNET_RPCS = [
  ...envRpcs('MAINNET_RPC_URL', 'NEXT_PUBLIC_MAINNET_RPC_URL'),
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
];

const BASE_RPCS = [
  ...envRpcs('BASE_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL'),
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://base.llamarpc.com',
];

const POLYGON_RPCS = [
  ...envRpcs('POLYGON_RPC_URL', 'NEXT_PUBLIC_POLYGON_RPC_URL'),
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
  'https://polygon-rpc.com',
];

const HYPEREVM_RPCS = [
  ...envRpcs('HYPEREVM_RPC_URL', 'NEXT_PUBLIC_HYPEREVM_RPC_URL'),
  'https://rpc.hyperliquid.xyz/evm',
];

const EVM_CHAINS = [
  { key: 'mainnet',  rpcs: MAINNET_RPCS,  chainId: 1,    nativeSymbol: 'ETH',  priceKey: 'eth' as const,  usdc: USDC_MAINNET as string | undefined, explorer: 'https://etherscan.io' },
  { key: 'base',     rpcs: BASE_RPCS,     chainId: 8453, nativeSymbol: 'ETH',  priceKey: 'eth' as const,  usdc: USDC_BASE    as string | undefined, explorer: 'https://basescan.org' },
  { key: 'polygon',  rpcs: POLYGON_RPCS,  chainId: 137,  nativeSymbol: 'POL',  priceKey: 'pol' as const,  usdc: USDC_POLYGON as string | undefined, explorer: 'https://polygonscan.com' },
  { key: 'hyperevm', rpcs: HYPEREVM_RPCS, chainId: 999,  nativeSymbol: 'HYPE', priceKey: 'hype' as const, usdc: undefined,                           explorer: 'https://www.hyperscan.com' },
] as const;
type EvmChain = (typeof EVM_CHAINS)[number];

function buildSolRpcList(): string[] {
  const list: string[] = [];
  const h = process.env.HELIUS_API_KEY;
  if (h) list.push(`https://mainnet.helius-rpc.com/?api-key=${h}`);
  list.push(
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
    'https://rpc.ankr.com/solana',
  );
  return list;
}

// ─── Helpers ───────────────────────────────────────────────────

async function solRpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
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
    console.warn('[portfolio] token-list fetch failed:', err instanceof Error ? err.message : err);
    return tokenListCache?.map ?? new Map();
  }
}

async function fetchJupiterPrices(mints: string[]): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map();
  const out = new Map<string, number>();
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
      console.warn('[portfolio] jup price failed:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}

type Prices = { eth: number; sol: number; pol: number; hype: number };

// ─── Hyperliquid L1 (perp + spot clearinghouse) ───────────────
// USDC on Hyperliquid lives in the off-chain clearinghouse, not as an
// ERC-20 on HyperEVM. We query the public info API to pull both.

async function hlInfo(body: unknown): Promise<any | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('[portfolio] hl info failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

type HyperliquidReport = {
  perpsUsd: number;   // marginSummary.accountValue — perp account equity in USDC
  spotUsdc: number;   // USDC held in the spot clearinghouse
  totalUsdc: number;  // perps + spot, shown as a single "USDC · Hyperliquid" row
};

async function fetchHyperliquid(address: string): Promise<HyperliquidReport> {
  const [perpState, spotState] = await Promise.all([
    hlInfo({ type: 'clearinghouseState', user: address }),
    hlInfo({ type: 'spotClearinghouseState', user: address }),
  ]);

  const perpsUsd = (() => {
    const v = perpState?.marginSummary?.accountValue;
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  const spotUsdc = (() => {
    const balances: any[] = Array.isArray(spotState?.balances) ? spotState.balances : [];
    const usdc = balances.find((b) => b?.coin === 'USDC');
    const v = usdc?.total;
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  return { perpsUsd, spotUsdc, totalUsdc: perpsUsd + spotUsdc };
}

async function fetchHypePrice(): Promise<number | null> {
  // Hyperliquid `allMids` returns a map of perp symbol → mid-price string.
  // HYPE perp mid ≈ spot price in practice; good enough for portfolio USD.
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const mid = data?.HYPE;
    const n = typeof mid === 'string' ? parseFloat(mid) : typeof mid === 'number' ? mid : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    console.warn('[portfolio] hype mid fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchPrices(): Promise<Prices> {
  const fallback: Prices = { eth: 3000, sol: 150, pol: 0.5, hype: 25 };

  const [ethRes, solRes, polRes, hypeMid] = await Promise.all([
    fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('https://api.coinbase.com/v2/prices/POL-USD/spot', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchHypePrice(),
  ]);
  return {
    eth:  parseFloat(ethRes?.data?.amount) || fallback.eth,
    sol:  parseFloat(solRes?.data?.amount) || fallback.sol,
    pol:  parseFloat(polRes?.data?.amount) || fallback.pol,
    hype: hypeMid ?? fallback.hype,
  };
}

// ─── EVM chain fetch ───────────────────────────────────────────

type EvmChainResult = {
  chainId: number;
  native: number;
  nativeSymbol: string;
  usdc?: number;
  source?: string;
  error?: string;
};

async function fetchEvmChain(address: string, chain: EvmChain): Promise<EvmChainResult> {
  for (const rpc of chain.rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });

      // Sanity check: some public RPCs silently serve a different chain than
      // advertised (load-balancer mis-routing, stale DNS, etc.), which would
      // return balances for the wrong network. Verify chainId before trusting
      // the balance — any mismatch → skip to the next RPC.
      const chainIdHex = await provider.send('eth_chainId', []);
      const reportedChainId = parseInt(chainIdHex, 16);
      if (reportedChainId !== chain.chainId) {
        console.warn(`[portfolio] ${chain.key} @ ${rpc}: chainId mismatch (expected ${chain.chainId}, got ${reportedChainId})`);
        continue;
      }

      const nativeP = provider.getBalance(address);
      const usdcP = chain.usdc
        ? (new ethers.Contract(chain.usdc, ['function balanceOf(address) view returns (uint256)'], provider)
            .balanceOf(address) as Promise<bigint>)
        : Promise.resolve(0n);
      const [nativeWei, usdcRaw] = await Promise.all([nativeP, usdcP]);
      return {
        chainId: chain.chainId,
        native: parseFloat(ethers.formatEther(nativeWei)),
        nativeSymbol: chain.nativeSymbol,
        usdc: chain.usdc ? parseFloat(ethers.formatUnits(usdcRaw, 6)) : undefined,
        source: rpc,
      };
    } catch (err) {
      console.warn(`[portfolio] ${chain.key} @ ${rpc} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return {
    chainId: chain.chainId,
    native: 0,
    nativeSymbol: chain.nativeSymbol,
    usdc: chain.usdc ? 0 : undefined,
    error: 'All RPCs failed',
  };
}

// ─── Solana fetch ──────────────────────────────────────────────

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

async function fetchSolana(address: string, minUsd: number): Promise<{
  sol: number;
  lamports: number;
  tokens: SolTokenRecord[];
  source?: string;
  error?: string;
}> {
  for (const rpc of buildSolRpcList()) {
    try {
      const [solResult, splResult, t22Result] = await Promise.all([
        solRpcCall(rpc, 'getBalance', [address]),
        solRpcCall(rpc, 'getTokenAccountsByOwner', [
          address,
          { programId: TOKEN_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]),
        solRpcCall(rpc, 'getTokenAccountsByOwner', [
          address,
          { programId: TOKEN_2022_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]).catch(() => ({ value: [] })),
      ]);

      const lamports = typeof solResult?.value === 'number' ? solResult.value : 0;

      const byMint = new Map<string, { mint: string; amount: number; decimals: number }>();
      const all = [...(splResult?.value ?? []), ...(t22Result?.value ?? [])];
      for (const acct of all) {
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
      const [metaMap, priceMap] = await Promise.all([getTokenMetaMap(), fetchJupiterPrices(mints)]);

      // Seed any missing stable prices from our known anchors so a flaky
      // Jupiter price endpoint can't hide USDC/USDT from the UI.
      for (const [mint, known] of Object.entries(KNOWN_SPL_META)) {
        if (!priceMap.has(mint)) priceMap.set(mint, known.priceUsd);
      }

      const tokens: SolTokenRecord[] = Array.from(byMint.values()).map((t) => {
        const meta = metaMap.get(t.mint);
        const known = KNOWN_SPL_META[t.mint];
        const priceUsd = priceMap.get(t.mint);
        const usd = priceUsd !== undefined ? t.amount * priceUsd : undefined;
        return {
          mint: t.mint,
          symbol: meta?.symbol ?? known?.symbol,
          name: meta?.name ?? known?.name,
          logo: meta?.logoURI,
          amount: t.amount,
          decimals: t.decimals,
          priceUsd,
          usd,
        };
      });

      // Dust filter, but always keep canonical stables (USDC, USDT) so they
      // never disappear from the portfolio breakdown regardless of minUsd.
      const filtered = tokens
        .filter((t) => {
          if (KNOWN_SPL_META[t.mint]) return true;
          if (minUsd === 0) return true;
          return (t.usd ?? 0) >= minUsd;
        })
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

      return {
        sol: lamports / 1e9,
        lamports,
        tokens: filtered,
        source: rpc.replace(/api-key=[^&]+/, 'api-key=***'),
      };
    } catch (err) {
      console.warn('[portfolio] sol rpc failed:', err instanceof Error ? err.message : err);
    }
  }
  return { sol: 0, lamports: 0, tokens: [], error: 'All Solana RPCs failed' };
}

// ─── GET handler ───────────────────────────────────────────────

type ChainReport = {
  chainId: number;
  native: number;
  nativeSymbol: string;
  nativeUsd: number;
  usdc?: number;
  usdcUsd?: number;
  explorer: string;
  source?: string;
  error?: string;
};

export async function GET(req: NextRequest) {
  const evmAddress = req.nextUrl.searchParams.get('evm');
  const solAddress = req.nextUrl.searchParams.get('sol');
  const minUsdParam = req.nextUrl.searchParams.get('minUsd');
  const minUsd = minUsdParam !== null && Number.isFinite(parseFloat(minUsdParam))
    ? Math.max(0, parseFloat(minUsdParam))
    : 0.5;

  if (!evmAddress && !solAddress) {
    return NextResponse.json(
      { error: 'Must supply at least one of ?evm or ?sol' },
      { status: 400 },
    );
  }

  const [prices, evmResults, solResult, hlResult] = await Promise.all([
    fetchPrices(),
    evmAddress
      ? Promise.all(EVM_CHAINS.map((c) => fetchEvmChain(evmAddress, c)))
      : Promise.resolve<EvmChainResult[]>([]),
    solAddress ? fetchSolana(solAddress, minUsd) : Promise.resolve(null),
    evmAddress ? fetchHyperliquid(evmAddress) : Promise.resolve<HyperliquidReport | null>(null),
  ]);

  const priceByKey: Record<EvmChain['priceKey'], number> = {
    eth: prices.eth,
    pol: prices.pol,
    hype: prices.hype,
  };

  const chains: Record<string, ChainReport> = {};
  for (let i = 0; i < evmResults.length; i++) {
    const r = evmResults[i];
    const c = EVM_CHAINS[i];
    if (!r) continue;
    const nativePrice = priceByKey[c.priceKey] ?? 0;
    chains[c.key] = {
      chainId: r.chainId,
      native: r.native,
      nativeSymbol: r.nativeSymbol,
      nativeUsd: r.native * nativePrice,
      ...(r.usdc !== undefined ? { usdc: r.usdc, usdcUsd: r.usdc } : {}),
      explorer: c.explorer,
      ...(r.source ? { source: r.source } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  const solana = solResult
    ? {
        address: solAddress,
        sol: solResult.sol,
        solUsd: solResult.sol * prices.sol,
        lamports: solResult.lamports,
        tokens: solResult.tokens,
        explorer: 'https://solscan.io',
        source: solResult.source,
        ...(solResult.error ? { error: solResult.error } : {}),
      }
    : null;

  const ethUsd = (chains.mainnet?.nativeUsd ?? 0) + (chains.base?.nativeUsd ?? 0);
  const hlUsdcUsd = hlResult?.totalUsdc ?? 0;
  const usdcUsd =
    (chains.mainnet?.usdcUsd ?? 0) +
    (chains.base?.usdcUsd ?? 0) +
    (chains.polygon?.usdcUsd ?? 0) +
    (solana?.tokens.find((t) => t.mint === SOL_USDC_MINT)?.usd ?? 0) +
    hlUsdcUsd;
  const polUsd = chains.polygon?.nativeUsd ?? 0;
  const hypeUsd = chains.hyperevm?.nativeUsd ?? 0;
  const solUsd = solana?.solUsd ?? 0;
  const splUsd = solana
    ? solana.tokens.filter((t) => t.mint !== SOL_USDC_MINT).reduce((s, t) => s + (t.usd ?? 0), 0)
    : 0;
  const grandTotalUsd = ethUsd + usdcUsd + polUsd + hypeUsd + solUsd + splUsd;

  return NextResponse.json({
    evmAddress,
    solAddress,
    prices,
    chains,
    solana,
    hyperliquid: hlResult,
    totals: {
      ethUsd,
      usdcUsd,
      polUsd,
      hypeUsd,
      solUsd,
      splUsd,
      hlUsdcUsd,
      grandTotalUsd,
    },
  });
}
