/**
 * Uniswap Hybrid V3 + V4 Integration (Base)
 *
 * Tries BOTH V3 and V4 on-chain quoters and routes through whichever
 * protocol gives the best output — all via the same Universal Router.
 *
 * Commands:
 *   0x00 = V3_SWAP_EXACT_IN
 *   0x0b = WRAP_ETH
 *   0x0c = UNWRAP_WETH
 *   0x10 = V4_SWAP
 */

import { ethers } from 'ethers';
import { TradeIntent, Quote, BuildSwapTx, ApprovalTx } from './types';
import { getToken, normalizeTokenSymbol } from './tokens';
import { calculateDeadline } from './policy';
import { getChainId } from './rpc';

// ─── Uniswap API ────────────────────────────────────────────────────────────
const UNISWAP_API_KEY  = process.env.NEXT_PUBLIC_UNISWAP_API_KEY || '';
const UNISWAP_API_BASE = 'https://api.uniswap.org/v2';

// ─── Contract Addresses on Base ─────────────────────────────────────────────
const UNIVERSAL_ROUTER = process.env.NEXT_PUBLIC_UNISWAP_ROUTER_ADDRESS || '0x6ff5693b99212da76ad316178a184ab56d299b43';
const V4_QUOTER        = process.env.NEXT_PUBLIC_UNISWAP_QUOTER_ADDRESS  || '0x0d5e0f971ed27fbff6c2837bf31316121532048d';
const V3_QUOTER        = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'; // QuoterV2 on Base
const PERMIT2_ADDRESS  = process.env.NEXT_PUBLIC_PERMIT2_ADDRESS          || '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const BASE_WETH        = '0x4200000000000000000000000000000000000006';

// ─── ABIs ───────────────────────────────────────────────────────────────────

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable returns (bytes[] memory)',
] as const;

// V3 QuoterV2 ABI (quoteExactInputSingle takes a struct)
const V3_QUOTER_ABI = [
  {
    inputs: [{
      components: [
        { name: 'tokenIn',            type: 'address'  },
        { name: 'tokenOut',           type: 'address'  },
        { name: 'amountIn',           type: 'uint256'  },
        { name: 'fee',                type: 'uint24'   },
        { name: 'sqrtPriceLimitX96',  type: 'uint160'  },
      ],
      name: 'params',
      type: 'tuple',
    }],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut',                type: 'uint256' },
      { name: 'sqrtPriceX96After',        type: 'uint160' },
      { name: 'initializedTicksCrossed',  type: 'uint32'  },
      { name: 'gasEstimate',              type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// V4 Quoter ABI
const V4_QUOTER_ABI = [
  {
    inputs: [{
      components: [
        { components: [
            { name: 'currency0',    type: 'address' },
            { name: 'currency1',    type: 'address' },
            { name: 'fee',          type: 'uint24'  },
            { name: 'tickSpacing',  type: 'int24'   },
            { name: 'hooks',        type: 'address' },
          ], name: 'poolKey', type: 'tuple' },
        { name: 'zeroForOne',        type: 'bool'    },
        { name: 'exactAmount',       type: 'uint128' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
        { name: 'hookData',          type: 'bytes'   },
      ],
      name: 'params',
      type: 'tuple',
    }],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'deltaAmounts',              type: 'int128[]' },
      { name: 'sqrtPriceX96After',         type: 'uint160'  },
      { name: 'initializedTicksLoaded',    type: 'uint32'   },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
] as const;

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function allowance(address user, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)',
] as const;

// ─── Constants ──────────────────────────────────────────────────────────────

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';
const MSG_SENDER   = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const MAX_UINT160  = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
const MAX_UINT256  = ethers.MaxUint256;
const MAX_UINT48   = 281474976710655n;

const HOOKS_ADDRESS = ADDRESS_ZERO;

// Universal Router command IDs
const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_WRAP_ETH         = 0x0b;
const CMD_UNWRAP_WETH      = 0x0c;
const CMD_V4_SWAP          = 0x10;

// V4 action IDs (from Uniswap v4-periphery Actions.sol)
// SWAP_EXACT_IN_SINGLE=0x00, SETTLE_ALL=0x0a, TAKE_ALL=0x0d
const V4Actions = {
  SWAP_EXACT_IN_SINGLE: 0x00,
  SETTLE_ALL: 0x0a,
  TAKE_ALL: 0x0d,
} as const;

// Fee tiers to try (ordered by liquidity likelihood)
const V3_FEE_TIERS = [500, 3000, 10000, 100];
const V4_POOL_CONFIGS: { fee: number; tickSpacing: number }[] = [
  { fee: 3000,  tickSpacing: 60  },
  { fee: 500,   tickSpacing: 10  },
  { fee: 10000, tickSpacing: 200 },
  { fee: 100,   tickSpacing: 1   },
];

const coder = ethers.AbiCoder.defaultAbiCoder();

// ─── Helpers ────────────────────────────────────────────────────────────────

function sortCurrencies(a: string, b: string): [string, string, boolean] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b, true] : [b, a, false];
}

function getCurrencyAddress(token: { symbol: string; address: string }): string {
  return (token.symbol === 'ETH' || token.address === ADDRESS_ZERO) ? ADDRESS_ZERO : token.address;
}

/** For V3 paths, ETH must be WETH */
function getV3Address(token: { symbol: string; address: string }): string {
  return (token.symbol === 'ETH' || token.address === ADDRESS_ZERO) ? BASE_WETH : token.address;
}

/** Encode a V3 swap path: tokenIn(20) + fee(3) + tokenOut(20)  */
function encodeV3Path(tokenIn: string, fee: number, tokenOut: string): string {
  return ethers.solidityPacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]);
}

// ─── V3 Quoter ──────────────────────────────────────────────────────────────

interface QuoteResult {
  amountOut: bigint;
  fee: number;
  version: 'v3' | 'v4';
  tickSpacing?: number; // V4 only
}

async function getV3Quotes(
  provider: ethers.JsonRpcProvider,
  tokenIn: string,   // WETH address for ETH
  tokenOut: string,   // WETH address for ETH
  amountIn: bigint,
): Promise<QuoteResult[]> {
  const quoter = new ethers.Contract(V3_QUOTER, V3_QUOTER_ABI, provider);
  const results: QuoteResult[] = [];

  const promises = V3_FEE_TIERS.map(async (fee) => {
    try {
      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
      });
      const amountOut: bigint = res.amountOut ?? res[0];
      if (amountOut > 0n) {
        console.log(`[V3 Quoter] ✅ fee=${fee}: amountOut=${amountOut.toString()}`);
        return { amountOut, fee, version: 'v3' as const };
      }
    } catch {
      // pool doesn't exist or no liquidity
    }
    console.log(`[V3 Quoter] ❌ fee=${fee}: no pool or error`);
    return null;
  });

  const settled = await Promise.all(promises);
  for (const r of settled) { if (r) results.push(r); }
  return results;
}

// ─── V4 Quoter ──────────────────────────────────────────────────────────────

async function getV4Quotes(
  provider: ethers.JsonRpcProvider,
  currencyIn: string,  // address(0) for ETH
  currencyOut: string,
  amountIn: bigint,
): Promise<QuoteResult[]> {
  const quoter = new ethers.Contract(V4_QUOTER, V4_QUOTER_ABI, provider);
  const results: QuoteResult[] = [];

  const promises = V4_POOL_CONFIGS.map(async (cfg) => {
    try {
      const [c0, c1, zeroForOne] = sortCurrencies(currencyIn, currencyOut);
      const res = await quoter.quoteExactInputSingle.staticCall({
        poolKey: { currency0: c0, currency1: c1, fee: cfg.fee, tickSpacing: cfg.tickSpacing, hooks: HOOKS_ADDRESS },
        zeroForOne,
        exactAmount: amountIn,
        sqrtPriceLimitX96: 0,
        hookData: '0x',
      });
      const deltaAmounts: bigint[] = res.deltaAmounts ?? res[0];
      const outIdx = zeroForOne ? 1 : 0;
      const amountOut = deltaAmounts[outIdx] < 0n ? -deltaAmounts[outIdx] : deltaAmounts[outIdx];
      if (amountOut > 0n) {
        console.log(`[V4 Quoter] ✅ fee=${cfg.fee}: amountOut=${amountOut.toString()}`);
        return { amountOut, fee: cfg.fee, version: 'v4' as const, tickSpacing: cfg.tickSpacing };
      }
    } catch {
      // pool doesn't exist
    }
    console.log(`[V4 Quoter] ❌ fee=${cfg.fee}: no pool or error`);
    return null;
  });

  const settled = await Promise.all(promises);
  for (const r of settled) { if (r) results.push(r); }
  return results;
}

// ─── Uniswap API Quote (uses API key) ───────────────────────────────────────

interface UniswapApiQuoteResult {
  amountOut: bigint;
  calldata: string;       // Pre-built calldata from the API
  value: string;          // tx value (hex)
  gasEstimate: string;
  routerAddress: string;  // Which router the API targets
}

/**
 * Fetch a quote (and pre-built calldata) from the Uniswap Routing API.
 * This is preferred over on-chain quoters when an API key is available
 * because the API does smarter multi-hop / split routing.
 */
async function getQuoteFromAPI(
  tokenInAddress: string,   // WETH address for native ETH
  tokenOutAddress: string,
  amountIn: bigint,
  slippageBps: number,
  recipient: string,
  chainId: number,
): Promise<UniswapApiQuoteResult | null> {
  if (!UNISWAP_API_KEY) {
    console.log('[API Quote] No UNISWAP_API_KEY set — skipping API quote');
    return null;
  }

  try {
    const slippageTolerance = slippageBps / 10000; // 50 bps → 0.005
    const deadline = Math.floor(Date.now() / 1000 + 60 * 20); // 20 min

    const url = new URL(`${UNISWAP_API_BASE}/quote`);
    url.searchParams.set('tokenInAddress', tokenInAddress);
    url.searchParams.set('tokenInChainId', chainId.toString());
    url.searchParams.set('tokenOutAddress', tokenOutAddress);
    url.searchParams.set('tokenOutChainId', chainId.toString());
    url.searchParams.set('amount', amountIn.toString());
    url.searchParams.set('type', 'exactIn');
    url.searchParams.set('recipient', recipient);
    url.searchParams.set('slippageTolerance', slippageTolerance.toString());
    url.searchParams.set('deadline', deadline.toString());

    console.log('[API Quote] Calling Uniswap API:', url.toString().replace(UNISWAP_API_KEY, '***'));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-api-key': UNISWAP_API_KEY,
      },
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`[API Quote] Uniswap API returned ${response.status}: ${errText.slice(0, 300)}`);
      return null;
    }

    const data = await response.json();
    const quote = data.quote ?? data;

    const amountOutRaw = quote.quote ?? quote.amountOut ?? quote.quoteDecimals;
    if (!amountOutRaw) {
      console.warn('[API Quote] No amountOut in response:', JSON.stringify(data).slice(0, 300));
      return null;
    }

    const methodParams = quote.methodParameters;
    if (!methodParams?.calldata) {
      console.warn('[API Quote] No methodParameters.calldata in response');
      return null;
    }

    const amountOut = BigInt(typeof amountOutRaw === 'string' ? amountOutRaw : amountOutRaw.toString());

    console.log(`[API Quote] ✅ API quote: amountOut=${amountOut.toString()}`);
    console.log(`[API Quote]   calldata length: ${methodParams.calldata.length}`);
    console.log(`[API Quote]   value: ${methodParams.value || '0x0'}`);
    console.log(`[API Quote]   gasEstimate: ${quote.gasUseEstimate || 'N/A'}`);

    return {
      amountOut,
      calldata: methodParams.calldata,
      value: methodParams.value || '0x0',
      gasEstimate: quote.gasUseEstimate || '0',
      routerAddress: UNIVERSAL_ROUTER, // API targets Universal Router
    };
  } catch (err) {
    console.warn('[API Quote] Uniswap API call failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── Best Quote (V3 vs V4) ─────────────────────────────────────────────────

async function getBestQuote(
  provider: ethers.JsonRpcProvider,
  tokenIn: { symbol: string; address: string },
  tokenOut: { symbol: string; address: string },
  amountIn: bigint,
): Promise<QuoteResult | null> {
  console.log('[Quote] Trying V3 + V4 quoters in parallel…');

  const v3In  = getV3Address(tokenIn);
  const v3Out = getV3Address(tokenOut);
  const v4In  = getCurrencyAddress(tokenIn);
  const v4Out = getCurrencyAddress(tokenOut);

  const [v3Results, v4Results] = await Promise.all([
    getV3Quotes(provider, v3In, v3Out, amountIn),
    getV4Quotes(provider, v4In, v4Out, amountIn),
  ]);

  const all = [...v3Results, ...v4Results];
  if (all.length === 0) return null;

  // Sort by output descending, but strongly prefer V3 when V4 doesn't beat it
  // by more than 0.5% — V4 encoding is more complex and V3 is battle-tested.
  all.sort((a, b) => {
    if (b.amountOut === a.amountOut) return 0;
    // If one is V3 and the other V4, only pick V4 if it's meaningfully better (>0.5%)
    if (a.version !== b.version) {
      const higher = b.amountOut > a.amountOut ? b : a;
      const lower  = b.amountOut > a.amountOut ? a : b;
      const threshold = lower.amountOut / 200n; // 0.5% of lower
      if (higher.amountOut - lower.amountOut <= threshold) {
        // Within 0.5% — prefer V3
        if (a.version === 'v3') return -1;
        if (b.version === 'v3') return 1;
      }
    }
    return b.amountOut > a.amountOut ? 1 : -1;
  });
  const best = all[0];
  console.log(`[Quote] 🏆 Best: ${best.version.toUpperCase()} fee=${best.fee}, amountOut=${best.amountOut.toString()}`);
  if (all.length > 1) {
    const second = all[1];
    console.log(`[Quote]    2nd: ${second.version.toUpperCase()} fee=${second.fee}, amountOut=${second.amountOut.toString()}`);
  }
  return best;
}

// ─── ETH Price ───────────────────────────────────────────────────────────────

// 60-second in-memory cache — avoids repeated slow RPC/API calls
let _ethPriceCache: { price: number; ts: number } | null = null;
const PRICE_CACHE_TTL_MS = 60_000;

/** Fetch a URL with a hard timeout (ms). Throws on timeout or HTTP error. */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function getEthPriceInUsd(provider?: ethers.JsonRpcProvider): Promise<number> {
  // 1. Return cached price if still fresh
  if (_ethPriceCache && Date.now() - _ethPriceCache.ts < PRICE_CACHE_TTL_MS) {
    console.log('[Price] ETH price (cache):', `$${_ethPriceCache.price.toFixed(2)}`);
    return _ethPriceCache.price;
  }

  console.log('[Price] Fetching ETH price…');

  // 2. CoinGecko — fast free API, 2 s timeout
  try {
    const res = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      2000,
    );
    if (res.ok) {
      const data = await res.json();
      const price: unknown = data?.ethereum?.usd;
      if (typeof price === 'number' && price > 0) {
        console.log('[Price] ETH price (CoinGecko):', `$${price.toFixed(2)}`);
        _ethPriceCache = { price, ts: Date.now() };
        return price;
      }
    }
  } catch (err) {
    console.warn('[Price] CoinGecko fetch failed:', err instanceof Error ? err.message : err);
  }

  // 3. Uniswap API (if key available)
  if (UNISWAP_API_KEY) {
    try {
      const usdc = getToken('USDC');
      if (usdc?.address) {
        const oneEth = ethers.parseEther('1');
        const chainId = getChainId();
        const apiResult = await getQuoteFromAPI(
          BASE_WETH, usdc.address, oneEth,
          50, ADDRESS_ZERO, chainId,
        );
        if (apiResult && apiResult.amountOut > 0n) {
          const price = parseFloat(ethers.formatUnits(apiResult.amountOut, 6));
          console.log('[Price] ETH price (Uniswap API):', `$${price.toFixed(2)}`);
          _ethPriceCache = { price, ts: Date.now() };
          return price;
        }
      }
    } catch (err) {
      console.warn('[Price] Uniswap API price fetch failed:', err instanceof Error ? err.message : err);
    }
  }

  // 4. On-chain V3 quoter — accurate but slowest; only if provider supplied
  if (provider) {
    try {
      const usdc = getToken('USDC');
      if (usdc?.address) {
        const oneEth = ethers.parseEther('1');
        const v3Results = await getV3Quotes(provider, BASE_WETH, usdc.address, oneEth);
        if (v3Results.length > 0) {
          v3Results.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
          const price = parseFloat(ethers.formatUnits(v3Results[0].amountOut, 6));
          console.log('[Price] ETH price (V3 on-chain):', `$${price.toFixed(2)}`);
          _ethPriceCache = { price, ts: Date.now() };
          return price;
        }
      }
    } catch (err) {
      console.warn('[Price] V3 price fetch failed:', err instanceof Error ? err.message : err);
    }
  }

  // 5. Conservative hardcoded fallback
  console.warn('[Price] Using $1800 conservative fallback');
  return 1800;
}

// ─── Amount Calculation ─────────────────────────────────────────────────────

async function calculateAmountIn(
  intent: TradeIntent,
  tokenIn: { symbol: string; decimals: number },
  provider?: ethers.JsonRpcProvider,
): Promise<bigint> {
  const sym = normalizeTokenSymbol(intent.tokenInSymbol);

  if (intent.amountUsd) {
    if (sym === 'USDC') {
      const raw = ethers.parseUnits(intent.amountUsd.toFixed(6), 6);
      console.log('[Amount] USD→USDC:', intent.amountUsd, '→', raw.toString());
      return raw;
    }
    if (sym === 'ETH') {
      const price = await getEthPriceInUsd(provider);
      const ethAmt = intent.amountUsd / price;
      const raw = ethers.parseUnits(ethAmt.toFixed(18), 18);
      console.log('[Amount] USD→ETH: $', intent.amountUsd, '@ $' + price.toFixed(2), '→', ethAmt.toFixed(8), 'ETH');
      return raw;
    }
    return ethers.parseUnits(intent.amountUsd.toFixed(6), tokenIn.decimals);
  }

  if (intent.amountToken) {
    const decimals = sym === 'USDC' ? 6 : sym === 'ETH' ? 18 : tokenIn.decimals;
    return ethers.parseUnits(intent.amountToken.toString(), decimals);
  }

  throw new Error('No amount specified (amountUsd or amountToken required)');
}

// ─── Fallback manual quote ──────────────────────────────────────────────────

function buildManualQuote(
  intent: TradeIntent,
  amountIn: bigint,
  tokenIn: { symbol: string; decimals: number },
  tokenOut: { symbol: string; decimals: number },
  ethPrice: number,
): Quote {
  const symIn  = normalizeTokenSymbol(intent.tokenInSymbol);
  const symOut = normalizeTokenSymbol(intent.tokenOutSymbol);

  let amountOut: bigint;
  if (symIn === 'USDC' && (symOut === 'ETH' || symOut === 'WETH')) {
    const usdAmt = parseFloat(ethers.formatUnits(amountIn, 6));
    amountOut = ethers.parseUnits((usdAmt / ethPrice).toFixed(18), 18);
  } else if ((symIn === 'ETH' || symIn === 'WETH') && symOut === 'USDC') {
    const ethAmt = parseFloat(ethers.formatEther(amountIn));
    amountOut = ethers.parseUnits((ethAmt * ethPrice).toFixed(6), 6);
  } else {
    amountOut = amountIn;
  }

  const safeSlippage = Math.max(intent.slippageBps, 500);
  const minOut = (amountOut * BigInt(10000 - safeSlippage)) / 10000n;

  return {
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minAmountOut: minOut.toString(),
    amountInFormatted: ethers.formatUnits(amountIn, tokenIn.decimals),
    amountOutFormatted: ethers.formatUnits(amountOut, tokenOut.decimals),
    minAmountOutFormatted: ethers.formatUnits(minOut, tokenOut.decimals),
    slippageBps: safeSlippage,
    route: [],
    swapVersion: 'v3', // manual fallback uses v3 path
    poolFee: 500,
  };
}

// ─── Public: getQuote ───────────────────────────────────────────────────────

export async function getQuote(intent: TradeIntent, walletAddress: string): Promise<Quote> {
  console.log('[Quote] ════════════════════════════════════════');
  console.log('[Quote] getQuote', JSON.stringify(intent));

  let tokenIn  = getToken(normalizeTokenSymbol(intent.tokenInSymbol));
  let tokenOut = getToken(normalizeTokenSymbol(intent.tokenOutSymbol));
  if (!tokenIn)  tokenIn  = await trySearchToken(intent.tokenInSymbol);
  if (!tokenOut) tokenOut = await trySearchToken(intent.tokenOutSymbol);
  if (!tokenIn)  throw new Error(`Token not found: ${intent.tokenInSymbol}`);
  if (!tokenOut) throw new Error(`Token not found: ${intent.tokenOutSymbol}`);

  const { getProviderWithRetry } = await import('./rpc');
  let provider: ethers.JsonRpcProvider | undefined;
  try { provider = await getProviderWithRetry(); } catch { /* no-op */ }

  const amountIn = await calculateAmountIn(intent, tokenIn, provider);
  console.log('[Quote] amountIn (raw):', amountIn.toString(), `(${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol})`);

  // ── 1) Try Uniswap API first (if API key is available) ──────────────────
  if (UNISWAP_API_KEY) {
    const chainId = getChainId();
    // API always uses WETH address for native ETH
    const apiTokenIn  = getV3Address(tokenIn);
    const apiTokenOut = getV3Address(tokenOut);

    const apiResult = await getQuoteFromAPI(
      apiTokenIn, apiTokenOut, amountIn,
      intent.slippageBps, walletAddress, chainId,
    );

    if (apiResult) {
      const minOut = (apiResult.amountOut * BigInt(10000 - intent.slippageBps)) / 10000n;
      const quote: Quote = {
        amountIn: amountIn.toString(),
        amountOut: apiResult.amountOut.toString(),
        minAmountOut: minOut.toString(),
        amountInFormatted: ethers.formatUnits(amountIn, tokenIn.decimals),
        amountOutFormatted: ethers.formatUnits(apiResult.amountOut, tokenOut.decimals),
        minAmountOutFormatted: ethers.formatUnits(minOut, tokenOut.decimals),
        slippageBps: intent.slippageBps,
        route: [],
        swapVersion: 'api',
        poolFee: 0,
        // Store the pre-built calldata from the API for later use in buildSwapTransaction
        apiCalldata: apiResult.calldata,
        apiValue: apiResult.value,
        gasEstimate: apiResult.gasEstimate,
      };
      console.log('[Quote] ✅ (Uniswap API)', quote.amountInFormatted, tokenIn.symbol, '→', quote.amountOutFormatted, tokenOut.symbol);
      console.log('[Quote] ════════════════════════════════════════');
      return quote;
    }
    console.log('[Quote] API quote unavailable — falling back to on-chain quoters');
  }

  // ── 2) Fall back to on-chain quoters ─────────────────────────────────────
  if (!provider) {
    const ethPrice = await getEthPriceInUsd();
    return buildManualQuote(intent, amountIn, tokenIn, tokenOut, ethPrice);
  }

  const best = await getBestQuote(provider, tokenIn, tokenOut, amountIn);

  if (best) {
    const minOut = (best.amountOut * BigInt(10000 - intent.slippageBps)) / 10000n;
    const quote: Quote = {
      amountIn: amountIn.toString(),
      amountOut: best.amountOut.toString(),
      minAmountOut: minOut.toString(),
      amountInFormatted: ethers.formatUnits(amountIn, tokenIn.decimals),
      amountOutFormatted: ethers.formatUnits(best.amountOut, tokenOut.decimals),
      minAmountOutFormatted: ethers.formatUnits(minOut, tokenOut.decimals),
      slippageBps: intent.slippageBps,
      route: [],
      swapVersion: best.version,
      poolFee: best.fee,
      poolTickSpacing: best.tickSpacing,
    };
    console.log('[Quote] ✅', quote.amountInFormatted, tokenIn.symbol, '→', quote.amountOutFormatted, tokenOut.symbol);
    console.log('[Quote]   via', best.version.toUpperCase(), 'fee=' + best.fee);
    console.log('[Quote] ════════════════════════════════════════');
    return quote;
  }

  console.warn('[Quote] All quoters failed — using manual estimate');
  const ethPrice = await getEthPriceInUsd(provider);
  const manual = buildManualQuote(intent, amountIn, tokenIn, tokenOut, ethPrice);
  console.log('[Quote] ════════════════════════════════════════');
  return manual;
}

// ─── V3 Calldata Encoding ───────────────────────────────────────────────────

function encodeV3Swap(
  tokenIn: { symbol: string; address: string },
  tokenOut: { symbol: string; address: string },
  amountIn: bigint,
  minAmountOut: bigint,
  fee: number,
  deadline: number,
): string {
  const isNativeIn  = tokenIn.symbol === 'ETH'  || tokenIn.address === ADDRESS_ZERO;
  const isNativeOut = tokenOut.symbol === 'ETH' || tokenOut.address === ADDRESS_ZERO;
  const v3In  = getV3Address(tokenIn);
  const v3Out = getV3Address(tokenOut);
  const path  = encodeV3Path(v3In, fee, v3Out);

  const routerIface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
  const commands: number[] = [];
  const inputs: string[] = [];

  if (isNativeIn) {
    // WRAP_ETH: wrap the sent ETH into WETH inside the router
    commands.push(CMD_WRAP_ETH);
    inputs.push(coder.encode(['address', 'uint256'], [ADDRESS_THIS, amountIn]));

    // V3_SWAP_EXACT_IN: WETH → tokenOut, payerIsUser=false (router has the WETH)
    commands.push(CMD_V3_SWAP_EXACT_IN);
    inputs.push(coder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [isNativeOut ? ADDRESS_THIS : MSG_SENDER, amountIn, minAmountOut, path, false],
    ));
  } else {
    // V3_SWAP_EXACT_IN: ERC20 → ..., payerIsUser=true (Permit2 pulls from user)
    commands.push(CMD_V3_SWAP_EXACT_IN);
    inputs.push(coder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [isNativeOut ? ADDRESS_THIS : MSG_SENDER, amountIn, minAmountOut, path, true],
    ));
  }

  if (isNativeOut) {
    // UNWRAP_WETH: unwrap and send ETH to user
    commands.push(CMD_UNWRAP_WETH);
    inputs.push(coder.encode(['address', 'uint256'], [MSG_SENDER, minAmountOut]));
  }

  const commandsHex = '0x' + commands.map(c => c.toString(16).padStart(2, '0')).join('');
  return routerIface.encodeFunctionData('execute', [commandsHex, inputs, deadline]);
}

// ─── V4 Calldata Encoding ───────────────────────────────────────────────────

function encodeV4Swap(
  currencyIn: string,
  currencyOut: string,
  fee: number,
  tickSpacing: number,
  amountIn: bigint,
  minAmountOut: bigint,
  deadline: number,
): string {
  const [c0, c1, zeroForOne_fromSort] = sortCurrencies(currencyIn, currencyOut);
  // zeroForOne = true when we're selling currency0
  const zeroForOne = currencyIn.toLowerCase() === c0.toLowerCase();

  const POOL_KEY_TYPE = '(address,address,uint24,int24,address)';
  const SWAP_STRUCT_TYPE = `(${POOL_KEY_TYPE},bool,uint128,uint128,bytes)`;

  const swapParam = coder.encode(
    [SWAP_STRUCT_TYPE],
    [[[c0, c1, fee, tickSpacing, HOOKS_ADDRESS], zeroForOne, amountIn, minAmountOut, '0x']],
  );
  const settleParam = coder.encode(['address', 'uint256'], [currencyIn, MAX_UINT256]);
  const takeParam   = coder.encode(['address', 'uint256'], [currencyOut, 0]);

  const actionsHex = '0x'
    + V4Actions.SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, '0')
    + V4Actions.SETTLE_ALL.toString(16).padStart(2, '0')
    + V4Actions.TAKE_ALL.toString(16).padStart(2, '0');

  const plannerData = coder.encode(['bytes', 'bytes[]'], [actionsHex, [swapParam, settleParam, takeParam]]);

  const routerIface = new ethers.Interface(UNIVERSAL_ROUTER_ABI);
  const commandsHex = '0x' + CMD_V4_SWAP.toString(16).padStart(2, '0');
  return routerIface.encodeFunctionData('execute', [commandsHex, [plannerData], deadline]);
}

// ─── Approval Checks (Permit2 flow for ERC-20s) ────────────────────────────

async function checkAndBuildApprovals(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  tokenSymbol: string,
  walletAddress: string,
  requiredAmount: bigint,
  chainId: number,
): Promise<ApprovalTx[]> {
  if (!tokenAddress || tokenAddress === ADDRESS_ZERO || tokenSymbol === 'ETH') {
    console.log('[Approval] Native ETH – no approvals needed');
    return [];
  }

  const approvals: ApprovalTx[] = [];
  const tokenContract   = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

  // Step 1: ERC20 → Permit2
  // If the RPC fails (rate limit, timeout, etc.), assume no allowance and include approval
  let erc20Allowance = 0n;
  try {
    // Retry with exponential backoff for rate limit errors
    const maxRetries = 3;
    const baseDelay = 1000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        erc20Allowance = await tokenContract.allowance(walletAddress, PERMIT2_ADDRESS);
        console.log('[Approval] ERC20→Permit2:', erc20Allowance.toString(), '/', requiredAmount.toString());
        break;
      } catch (err: any) {
        const isRateLimit = err?.code === -32016 || 
                           err?.message?.includes('over rate limit') ||
                           err?.message?.includes('rate limit');
        if (isRateLimit && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.warn(`[Approval] Rate limit error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.warn('[Approval] ⚠️ Failed to check ERC20 allowance (RPC error) — will include approval tx:', (err as Error).message?.slice(0, 120));
  }

  if (erc20Allowance < requiredAmount) {
    // Build approval calldata locally (no RPC needed)
    const iface = new ethers.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('approve', [PERMIT2_ADDRESS, MAX_UINT256]);
    approvals.push({
      to: tokenAddress, data, value: '0x0', chainId,
      label: `Approve ${tokenSymbol} for Permit2`,
      tokenSymbol, tokenAddress, spender: PERMIT2_ADDRESS, amount: 'unlimited',
    });
  }

  // Step 2: Permit2 → Universal Router
  let p2Amount = 0n;
  try {
    const result: [bigint, bigint, bigint] = await permit2Contract.allowance(walletAddress, tokenAddress, UNIVERSAL_ROUTER);
    p2Amount = result[0];
    console.log('[Approval] Permit2→Router:', p2Amount.toString(), '/', requiredAmount.toString());
  } catch (err) {
    console.warn('[Approval] ⚠️ Failed to check Permit2 allowance (RPC error) — will include approval tx:', (err as Error).message?.slice(0, 120));
  }

  if (p2Amount < requiredAmount) {
    const iface = new ethers.Interface(PERMIT2_ABI);
    const data = iface.encodeFunctionData('approve', [tokenAddress, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48]);
    approvals.push({
      to: PERMIT2_ADDRESS, data, value: '0x0', chainId,
      label: `Approve ${tokenSymbol} for Universal Router (via Permit2)`,
      tokenSymbol, tokenAddress, spender: UNIVERSAL_ROUTER, amount: 'unlimited',
    });
  }

  console.log('[Approval]', approvals.length === 0 ? '✅ All good' : `→ ${approvals.length} approval(s) needed`);
  return approvals;
}

// ─── Public: buildSwapTransaction ───────────────────────────────────────────

export async function buildSwapTransaction(
  intent: TradeIntent,
  quote: Quote,
  walletAddress: string,
): Promise<BuildSwapTx> {
  console.log('[Build] ════════════════════════════════════════');
  console.log('[Build] Building swap:', intent.tokenInSymbol, '→', intent.tokenOutSymbol);
  console.log('[Build] Route:', (quote.swapVersion || 'v3').toUpperCase(), 'fee=' + (quote.poolFee || 500));

  // Resolve tokens
  let tokenIn  = getToken(normalizeTokenSymbol(intent.tokenInSymbol));
  let tokenOut = getToken(normalizeTokenSymbol(intent.tokenOutSymbol));
  if (!tokenIn)  tokenIn  = await trySearchToken(intent.tokenInSymbol);
  if (!tokenOut) tokenOut = await trySearchToken(intent.tokenOutSymbol);
  if (!tokenIn)  throw new Error(`Token not found: ${intent.tokenInSymbol}`);
  if (!tokenOut) throw new Error(`Token not found: ${intent.tokenOutSymbol}`);

  const { getProviderWithRetry } = await import('./rpc');
  const provider = await getProviderWithRetry();
  const network = await provider.getNetwork();
  console.log('[Build] Network:', network.name, 'Chain ID:', network.chainId.toString());

  // Use the exact amountIn from the quote — do NOT recalculate here.
  // getQuote already computed the right ETH amount using the on-chain price.
  // Recalculating with a potentially stale/fallback price causes amountIn to
  // mismatch quote.minAmountOut, making the swap revert (too little ETH sent
  // → pool gives less USDC than minAmountOut).
  const amountIn = BigInt(quote.amountIn);
  console.log('[Build] amountIn from quote:', ethers.formatUnits(amountIn, tokenIn.decimals), tokenIn.symbol);

  const chainId  = getChainId();
  const isNativeIn = normalizeTokenSymbol(intent.tokenInSymbol) === 'ETH';

  // ── If quote came from the Uniswap API, use pre-built calldata ──────────
  if (quote.swapVersion === 'api' && quote.apiCalldata) {
    console.log('[Build] Using pre-built calldata from Uniswap API');
    console.log('[Build] Calldata length:', quote.apiCalldata.length);

    // Check approvals (ERC-20 input only)
    const tokenForApproval = isNativeIn ? ADDRESS_ZERO : tokenIn.address;
    const approvalTxs = await checkAndBuildApprovals(provider, tokenForApproval, tokenIn.symbol, walletAddress, amountIn, chainId);

    const txValue = quote.apiValue || (isNativeIn ? `0x${amountIn.toString(16)}` : '0x0');

    // Gas estimate
    let gasEstimate: string | undefined = quote.gasEstimate || undefined;
    if (!gasEstimate || gasEstimate === '0') {
      try {
        const gas = await provider.estimateGas({ to: UNIVERSAL_ROUTER, data: quote.apiCalldata, value: txValue, from: walletAddress });
        gasEstimate = gas.toString();
        console.log('[Build] ✅ Gas estimate:', gasEstimate);
      } catch (e) {
        console.warn('[Build] ⚠️ Gas est. failed (non-critical):', (e instanceof Error ? e.message : String(e)).slice(0, 200));
      }
    }

    const result: BuildSwapTx = {
      to: UNIVERSAL_ROUTER,
      data: quote.apiCalldata,
      value: txValue,
      chainId,
      gas: gasEstimate,
      deadline: Math.floor(Date.now() / 1000 + 60 * 20),
      needsApproval: approvalTxs.length > 0,
      approvalTransactions: approvalTxs.length > 0 ? approvalTxs : undefined,
      approvalTransaction: approvalTxs.length > 0 ? approvalTxs[0] : undefined,
    };

    console.log('[Build] ✅ Transaction built (Uniswap API calldata)');
    console.log('[Build]   to:', result.to);
    console.log('[Build]   value:', result.value);
    console.log('[Build]   gas:', result.gas || '(est. failed)');
    console.log('[Build]   approvals:', approvalTxs.length);
    console.log('[Build] ════════════════════════════════════════');

    return result;
  }

  // ── Otherwise: manually encode calldata from on-chain quote ─────────────

  // If quote has no version, re-discover best route
  let swapVersion = quote.swapVersion || 'v3';
  let poolFee     = quote.poolFee || 500;
  let tickSpacing = quote.poolTickSpacing || 10;
  let minAmountOut = BigInt(quote.minAmountOut);

  if (!quote.swapVersion) {
    console.log('[Build] No swap version in quote — re-discovering…');
    const best = await getBestQuote(provider, tokenIn, tokenOut, amountIn);
    if (best) {
      swapVersion = best.version;
      poolFee = best.fee;
      tickSpacing = best.tickSpacing || 10;
      minAmountOut = (best.amountOut * BigInt(10000 - intent.slippageBps)) / 10000n;
      console.log('[Build] Discovered:', best.version.toUpperCase(), 'fee=' + best.fee, 'amountOut=' + best.amountOut.toString());
    }
  }

  const deadline = calculateDeadline();

  console.log('[Build] Version:', swapVersion.toUpperCase());
  console.log('[Build] In :', tokenIn.symbol, isNativeIn ? '(native ETH)' : tokenIn.address);
  console.log('[Build] Out:', tokenOut.symbol, tokenOut.address);
  console.log('[Build] amountIn:', amountIn.toString(), `(${ethers.formatUnits(amountIn, tokenIn.decimals)} ${tokenIn.symbol})`);
  console.log('[Build] minAmountOut:', minAmountOut.toString(), `(${ethers.formatUnits(minAmountOut, tokenOut.decimals)} ${tokenOut.symbol})`);

  // Check approvals (for ERC-20 input only)
  const tokenForApproval = isNativeIn ? ADDRESS_ZERO : tokenIn.address;
  const approvalTxs = await checkAndBuildApprovals(provider, tokenForApproval, tokenIn.symbol, walletAddress, amountIn, chainId);

  // Encode calldata based on version
  let data: string;
  if (swapVersion === 'v4') {
    const currIn  = getCurrencyAddress(tokenIn);
    const currOut = getCurrencyAddress(tokenOut);
    data = encodeV4Swap(currIn, currOut, poolFee, tickSpacing, amountIn, minAmountOut, deadline);
    console.log('[Build] Encoded V4 swap, calldata length:', data.length);
  } else {
    data = encodeV3Swap(tokenIn, tokenOut, amountIn, minAmountOut, poolFee, deadline);
    console.log('[Build] Encoded V3 swap, calldata length:', data.length);
  }

  // Transaction value
  const txValue = isNativeIn ? `0x${amountIn.toString(16)}` : '0x0';
  console.log('[Build] tx value:', txValue, isNativeIn ? `(${ethers.formatEther(amountIn)} ETH)` : '(0)');

  // Gas estimate — if it fails with a revert, the tx would definitely fail on-chain.
  // Throw rather than silently submitting a doomed transaction.
  let gasEstimate: string | undefined;
  try {
    const gas = await provider.estimateGas({ to: UNIVERSAL_ROUTER, data, value: txValue, from: walletAddress });
    gasEstimate = gas.toString();
    console.log('[Build] ✅ Gas estimate:', gasEstimate);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[Build] ⚠️ Gas estimation failed:', msg.slice(0, 300));
    if (msg.includes('0x8b063d73')) {
      throw new Error('Swap would revert: pool output is below minimum (price moved too much). Try again or increase slippage.');
    }
    if (msg.includes('execution reverted') || msg.includes('CALL_EXCEPTION') || msg.includes('missing revert data')) {
      // Re-attempt with higher slippage (2%) as a fallback before giving up
      if (intent.slippageBps < 200) {
        console.log('[Build] Retrying with 200 bps slippage…');
        const looserMin = (BigInt(quote.amountOut) * 9800n) / 10000n;
        const looserData = swapVersion === 'v4'
          ? encodeV4Swap(getCurrencyAddress(tokenIn), getCurrencyAddress(tokenOut), poolFee, tickSpacing, amountIn, looserMin, deadline)
          : encodeV3Swap(tokenIn, tokenOut, amountIn, looserMin, poolFee, deadline);
        try {
          const gas2 = await provider.estimateGas({ to: UNIVERSAL_ROUTER, data: looserData, value: txValue, from: walletAddress });
          gasEstimate = gas2.toString();
          data = looserData; // use the looser version
          minAmountOut = looserMin;
          console.log('[Build] ✅ Retry with looser slippage succeeded, gas:', gasEstimate);
        } catch (e2) {
          throw new Error('Swap would revert even with 2% slippage. Check that you have enough balance and the pool exists.');
        }
      } else {
        throw new Error('Swap would revert on-chain. The pool may not have enough liquidity or price moved too much.');
      }
    }
    // For other errors (e.g. RPC issues), continue without gas estimate
  }

  const result: BuildSwapTx = {
    to: UNIVERSAL_ROUTER,
    data,
    value: txValue,
    chainId,
    gas: gasEstimate,
    deadline,
    needsApproval: approvalTxs.length > 0,
    approvalTransactions: approvalTxs.length > 0 ? approvalTxs : undefined,
    approvalTransaction: approvalTxs.length > 0 ? approvalTxs[0] : undefined,
  };

  console.log('[Build] ✅ Transaction built');
  console.log('[Build]   to:', result.to);
  console.log('[Build]   value:', result.value);
  console.log('[Build]   gas:', result.gas || '(est. failed)');
  console.log('[Build]   approvals:', approvalTxs.length);
  console.log('[Build]   version:', swapVersion.toUpperCase());
  console.log('[Build] ════════════════════════════════════════');

  return result;
}

// ─── Token search helper ────────────────────────────────────────────────────

async function trySearchToken(symbol: string) {
  const { searchTokenAddress } = await import('./tokens');
  return searchTokenAddress(symbol);
}

// ─── Legacy export ──────────────────────────────────────────────────────────

export async function checkTokenApproval(
  provider: ethers.Provider,
  tokenAddress: string,
  walletAddress: string,
  routerAddress: string,
  requiredAmount: bigint,
  tokenSymbol?: string,
): Promise<{ hasApproval: boolean; allowance: bigint; needsApproval: boolean }> {
  if (!tokenAddress || tokenAddress === ADDRESS_ZERO || tokenSymbol === 'ETH') {
    return { hasApproval: true, allowance: MAX_UINT256, needsApproval: false };
  }
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const allowance: bigint = await token.allowance(walletAddress, PERMIT2_ADDRESS);
  return { hasApproval: allowance >= requiredAmount, allowance, needsApproval: allowance < requiredAmount };
}
