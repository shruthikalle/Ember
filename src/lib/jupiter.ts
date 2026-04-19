/**
 * Jupiter DEX integration for Solana swaps.
 *
 * Jupiter V6 API:
 *   1. GET  /quote   → best route + price
 *   2. POST /swap    → serialized VersionedTransaction (base64)
 *
 * The returned transaction is signed client-side by Phantom wallet.
 */

const JUPITER_API = 'https://api.jup.ag/swap/v1';

// ─── Well-known Solana token mints ─────────────────────────────────────────

export const SOLANA_MINTS: Record<string, { mint: string; decimals: number; symbol: string }> = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112',     decimals: 9,  symbol: 'SOL'  },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6,  symbol: 'USDC' },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  decimals: 6,  symbol: 'USDT' },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5,  symbol: 'BONK' },
  JUP:  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6,  symbol: 'JUP'  },
  WIF:  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6,  symbol: 'WIF'  },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6,  symbol: 'PYTH' },
};

/** Tokens that only exist on Solana — used to detect chain routing */
export const SOLANA_ONLY_TOKENS = new Set(['SOL', 'BONK', 'JUP', 'WIF', 'PYTH']);

/** Check if a trade should route through Jupiter (Solana) */
export function isSolanaSwap(tokenInSymbol: string, tokenOutSymbol: string): boolean {
  const a = tokenInSymbol.toUpperCase();
  const b = tokenOutSymbol.toUpperCase();
  return SOLANA_ONLY_TOKENS.has(a) || SOLANA_ONLY_TOKENS.has(b);
}

/** Resolve a symbol to a Solana mint address */
export function getSolanaMint(symbol: string): string | null {
  const entry = SOLANA_MINTS[symbol.toUpperCase()];
  return entry?.mint ?? null;
}

export function getSolanaDecimals(symbol: string): number {
  return SOLANA_MINTS[symbol.toUpperCase()]?.decimals ?? 9;
}

// ─── Jupiter Quote ─────────────────────────────────────────────────────────

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  // The full raw response — needed for /swap call
  raw: unknown;
}

export async function getJupiterQuote(
  inputSymbol: string,
  outputSymbol: string,
  amountRaw: string,       // Smallest unit (lamports / token base units)
  slippageBps = 50,
): Promise<JupiterQuote> {
  const inputMint = getSolanaMint(inputSymbol);
  const outputMint = getSolanaMint(outputSymbol);

  if (!inputMint || !outputMint) {
    throw new Error(`Unknown Solana token: ${!inputMint ? inputSymbol : outputSymbol}`);
  }

  const url = new URL(`${JUPITER_API}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amountRaw);
  url.searchParams.set('slippageBps', String(slippageBps));

  console.log('[Jupiter] Fetching quote:', url.toString());

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
  }

  const data = await res.json();

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    otherAmountThreshold: data.otherAmountThreshold,
    slippageBps: data.slippageBps,
    priceImpactPct: data.priceImpactPct ?? '0',
    routePlan: data.routePlan ?? [],
    raw: data,
  };
}

// ─── Jupiter Swap (build serialized transaction) ───────────────────────────

export interface JupiterSwapResult {
  /** Base64-encoded Solana VersionedTransaction — sign with Phantom */
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export async function buildJupiterSwapTx(
  quoteResponse: unknown,
  userPublicKey: string,
): Promise<JupiterSwapResult> {
  console.log('[Jupiter] Building swap tx for wallet:', userPublicKey);

  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter swap build failed (${res.status}): ${body}`);
  }

  const data = await res.json();

  if (!data.swapTransaction) {
    throw new Error('Jupiter returned no swapTransaction');
  }

  return {
    swapTransaction: data.swapTransaction,
    lastValidBlockHeight: data.lastValidBlockHeight ?? 0,
  };
}

// ─── SOL Price (via Jupiter Price API v2) ─────────────────────────────────

// 60-second in-memory cache for SOL price
let _solPriceCache: { price: number; ts: number } | null = null;
const SOL_PRICE_CACHE_TTL_MS = 60_000;

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the current SOL/USD price.
 * Sources tried in order: cache → CoinGecko → Jupiter Price API → $150 fallback.
 */
export async function getSolPriceInUsd(): Promise<number> {
  // 1. Cached price
  if (_solPriceCache && Date.now() - _solPriceCache.ts < SOL_PRICE_CACHE_TTL_MS) {
    console.log('[Jupiter] SOL price (cache):', `$${_solPriceCache.price.toFixed(2)}`);
    return _solPriceCache.price;
  }

  console.log('[Jupiter] Fetching SOL price…');

  // 2. CoinGecko — fast, 2 s timeout
  try {
    const res = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      2000,
    );
    if (res.ok) {
      const data = await res.json();
      const price: unknown = data?.solana?.usd;
      if (typeof price === 'number' && price > 0) {
        console.log('[Jupiter] SOL price (CoinGecko):', `$${price.toFixed(2)}`);
        _solPriceCache = { price, ts: Date.now() };
        return price;
      }
    }
  } catch (err) {
    console.warn('[Jupiter] CoinGecko SOL price failed:', err instanceof Error ? err.message : err);
  }

  // 3. Jupiter Price API v2, 2 s timeout
  try {
    const res = await fetchWithTimeout(
      'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
      2000,
    );
    if (res.ok) {
      const data = await res.json();
      const price: unknown = data?.data?.['So11111111111111111111111111111111111111112']?.price;
      if (typeof price === 'number' && price > 0) {
        console.log('[Jupiter] SOL price (Jupiter API):', `$${price.toFixed(2)}`);
        _solPriceCache = { price, ts: Date.now() };
        return price;
      }
    }
  } catch (err) {
    console.warn('[Jupiter] Jupiter SOL price failed:', err instanceof Error ? err.message : err);
  }

  console.warn('[Jupiter] Using $150 conservative SOL price fallback');
  return 150;
}

// ─── High-level: quote + build in one call ─────────────────────────────────

export async function getJupiterSwap(
  inputSymbol: string,
  outputSymbol: string,
  amountRaw: string,
  userPublicKey: string,
  slippageBps = 50,
): Promise<{
  quote: JupiterQuote;
  swap: JupiterSwapResult;
}> {
  const quote = await getJupiterQuote(inputSymbol, outputSymbol, amountRaw, slippageBps);
  const swap = await buildJupiterSwapTx(quote.raw, userPublicKey);
  return { quote, swap };
}
