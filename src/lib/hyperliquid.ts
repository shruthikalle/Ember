/**
 * Hyperliquid Perpetuals Integration
 *
 * Hyperliquid is a high-performance L1 blockchain purpose-built for trading.
 * - Market data: via api.hyperliquid.xyz/info (or QuickNode HyperCore if configured)
 * - Trading: signed EIP-712 messages via @nktkas/hyperliquid SDK
 * - Collateral: USDC (deposited from Arbitrum)
 *
 * This file handles server-side market data queries.
 * Trade execution happens client-side via MetaMask signing.
 */

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function hlInfo(body: Record<string, unknown>) {
  // Route through QuickNode HyperCore if configured, otherwise use public API
  const { qnInfo } = await import('./quicknode-stream');
  return qnInfo(body);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HLMarketData {
  coin: string;
  assetIndex: number;
  markPrice: string;
  midPrice: string;
  oraclePrice: string;
  fundingRate: string;
  openInterest: string;
  volume24h: string;
  prevDayPrice: string;
  priceChange24hPct: string;
  maxLeverage: number;
  szDecimals: number;
  tickSize: number; // Minimum price increment (e.g., 0.01, 0.1, 1.0)
}

export interface HLTradeParams {
  assetIndex: number;
  coin: string;
  side: 'LONG' | 'SHORT';
  size: string;
  price: string;
  leverage: number;
  szDecimals: number;
  reduceOnly: boolean;
  orderType: 'market' | 'limit';
  tickSize: number;
}

export interface HLCloseParams {
  assetIndex: number;
  coin: string;
  size: string;
  price: string;
  isBuy: boolean;
  szDecimals: number;
  tickSize: number;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  // Hyperliquid metadata may include tick size or we calculate from price precision
  [key: string]: unknown;
}

interface AssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium?: string;
  oraclePx: string;
  markPx: string;
  midPx?: string;
  impactPxs?: [string, string];
}

let _metaCache: { universe: AssetMeta[]; ctxs: AssetCtx[] } | null = null;
let _metaCacheTime = 0;
const CACHE_TTL = 10_000; // 10 seconds

async function getMetaAndCtxs(): Promise<{ universe: AssetMeta[]; ctxs: AssetCtx[] }> {
  if (_metaCache && Date.now() - _metaCacheTime < CACHE_TTL) return _metaCache;

  console.log('[Hyperliquid] Fetching metaAndAssetCtxs…');
  const [meta, ctxs] = await hlInfo({ type: 'metaAndAssetCtxs' });
  _metaCache = { universe: meta.universe, ctxs };
  _metaCacheTime = Date.now();
  console.log(`[Hyperliquid] Loaded ${meta.universe.length} perp markets`);
  return _metaCache;
}

// ─── Market Data ────────────────────────────────────────────────────────────

/**
 * Fetch real-time market data for a specific coin.
 * Accepts: "BTC", "ETH", "ETH-USD", "ETH/USD", etc.
 */
export async function getMarketData(coin: string): Promise<HLMarketData> {
  const { universe, ctxs } = await getMetaAndCtxs();

  const normalized = coin
    .replace(/[/-]USD$/i, '')
    .replace(/USD$/i, '')
    .toUpperCase()
    .trim();

  const idx = universe.findIndex((a) => a.name.toUpperCase() === normalized);
  if (idx === -1) {
    const available = universe.slice(0, 30).map((a) => a.name).join(', ');
    throw new Error(`Market "${coin}" not found on Hyperliquid. Try: ${available}`);
  }

  const meta = universe[idx];
  const ctx = ctxs[idx];

  const markPrice = parseFloat(ctx.markPx || '0');
  const prevDayPrice = parseFloat(ctx.prevDayPx || '0');
  const priceChangePct =
    prevDayPrice > 0
      ? ((markPrice - prevDayPrice) / prevDayPrice) * 100
      : 0;
  
  // Calculate tick size from price
  const tickSize = calculateTickSize(markPrice);

  return {
    coin: meta.name,
    assetIndex: idx,
    markPrice: ctx.markPx || '0',
    midPrice: ctx.midPx || ctx.markPx || '0',
    oraclePrice: ctx.oraclePx || ctx.markPx || '0',
    fundingRate: ctx.funding || '0',
    openInterest: ctx.openInterest || '0',
    volume24h: ctx.dayNtlVlm || '0',
    prevDayPrice: ctx.prevDayPx || '0',
    priceChange24hPct: priceChangePct.toFixed(2),
    maxLeverage: meta.maxLeverage || 50,
    szDecimals: meta.szDecimals ?? 2,
    tickSize,
  };
}

/**
 * Fetch data for all perp markets.
 */
export async function getAllMarkets(): Promise<HLMarketData[]> {
  const { universe, ctxs } = await getMetaAndCtxs();

  return universe.map((meta, idx) => {
    const ctx = ctxs[idx] || ({} as AssetCtx);
    const markPrice = parseFloat(ctx.markPx || '0');
    const prevDayPrice = parseFloat(ctx.prevDayPx || '0');
    const priceChangePct =
      prevDayPrice > 0
        ? ((markPrice - prevDayPrice) / prevDayPrice) * 100
        : 0;
    
    // Calculate tick size from price
    const tickSize = calculateTickSize(markPrice);

    return {
      coin: meta.name,
      assetIndex: idx,
      markPrice: ctx.markPx || '0',
      midPrice: ctx.midPx || ctx.markPx || '0',
      oraclePrice: ctx.oraclePx || ctx.markPx || '0',
      fundingRate: ctx.funding || '0',
      openInterest: ctx.openInterest || '0',
      volume24h: ctx.dayNtlVlm || '0',
      prevDayPrice: ctx.prevDayPx || '0',
      priceChange24hPct: priceChangePct.toFixed(2),
      maxLeverage: meta.maxLeverage || 50,
      szDecimals: meta.szDecimals ?? 2,
      tickSize,
    };
  });
}

// ─── Account Data ───────────────────────────────────────────────────────────

/**
 * Fetch a user's clearinghouse state (balances, positions, margin).
 * Addresses are lowercased to match Hyperliquid API expectations.
 */
export async function getUserState(address: string) {
  return hlInfo({ type: 'clearinghouseState', user: address.toLowerCase() });
}

/**
 * Fetch a user's spot clearinghouse state (spot token balances).
 */
export async function getUserSpotState(address: string) {
  return hlInfo({
    type: 'spotClearinghouseState',
    user: address.toLowerCase(),
  });
}

/**
 * Fetch a user's open orders.
 */
export async function getUserOpenOrders(address: string) {
  return hlInfo({ type: 'openOrders', user: address.toLowerCase() });
}

// ─── Trade Parameter Builders ───────────────────────────────────────────────

/**
 * Calculate tick size from price precision.
 * Hyperliquid uses standard tick sizes: 0.01, 0.1, 1, 10, etc.
 */
function calculateTickSize(price: number): number {
  // Determine appropriate tick size based on price magnitude
  if (price >= 10000) return 1.0;      // BTC, ETH: 1.0
  if (price >= 1000) return 0.1;       // High-value assets: 0.1
  if (price >= 100) return 0.01;       // Mid-range: 0.01
  if (price >= 1) return 0.0001;      // Lower: 0.0001
  if (price >= 0.01) return 0.000001; // Very low: 0.000001
  return 0.00000001;                   // Minimum: 0.00000001
}

/**
 * Round price to the nearest tick size.
 */
function roundToTickSize(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

/**
 * Format a price string with appropriate precision, rounded to tick size.
 */
function formatPrice(price: number, tickSize: number): string {
  const rounded = roundToTickSize(price, tickSize);
  
  // Determine decimal places from tick size
  const tickStr = tickSize.toString();
  const decimalPlaces = tickStr.includes('.') 
    ? tickStr.split('.')[1].length 
    : 0;
  
  return rounded.toFixed(decimalPlaces);
}

/**
 * Build trade parameters for a perp order.
 * The frontend uses these to construct and sign the order via the SDK.
 */
export function buildTradeParams(
  assetIndex: number,
  coin: string,
  side: 'LONG' | 'SHORT',
  sizeUsd: number,
  leverage: number,
  currentPrice: number,
  szDecimals: number,
  tickSize: number,
): HLTradeParams {
  // Calculate base asset size from USD collateral and leverage
  const notional = sizeUsd * leverage;
  const baseSize = notional / currentPrice;
  const sizeStr = baseSize.toFixed(szDecimals);
  
  // #region agent log
  console.log('[DEBUG] buildTradeParams:', {
    sizeUsd,
    leverage,
    notional,
    currentPrice,
    baseSize,
    sizeStr,
    szDecimals,
    sizeNum: parseFloat(sizeStr),
  });
  // #endregion
  
  // Validate minimum size - Hyperliquid requires non-zero size
  const sizeNum = parseFloat(sizeStr);
  if (sizeNum <= 0 || sizeStr === '0' || sizeStr === '0.00' || sizeStr === '0.0') {
    throw new Error(
      `Order size too small: calculated size is ${sizeStr} ${coin} ($${sizeUsd} at ${leverage}x = $${notional.toFixed(2)} notional). ` +
      `Minimum order size is typically 0.01 ${coin} or higher. Please increase position size.`
    );
  }

  // For market orders, use IOC with 1% slippage
  // Round to tick size to avoid "Price must be divisible by tick size" error
  const slippageMult = side === 'LONG' ? 1.01 : 0.99;
  const rawPrice = currentPrice * slippageMult;
  const priceStr = formatPrice(rawPrice, tickSize);

  return {
    assetIndex,
    coin,
    side,
    size: sizeStr,
    price: priceStr,
    leverage,
    szDecimals,
    reduceOnly: false,
    orderType: 'market',
    tickSize,
  };
}

/**
 * Build parameters for closing a position.
 */
export function buildCloseParams(
  assetIndex: number,
  coin: string,
  currentSize: string,
  currentPrice: number,
  szDecimals: number,
  tickSize: number,
): HLCloseParams {
  const sizeNum = parseFloat(currentSize);
  const isLong = sizeNum > 0;
  const absSize = Math.abs(sizeNum).toFixed(szDecimals);

  // To close a long → sell, to close a short → buy
  // Round to tick size to avoid "Price must be divisible by tick size" error
  const isBuy = !isLong;
  const slippageMult = isBuy ? 1.01 : 0.99;
  const rawPrice = currentPrice * slippageMult;
  const priceStr = formatPrice(rawPrice, tickSize);

  return {
    assetIndex,
    coin,
    size: absSize,
    price: priceStr,
    isBuy,
    szDecimals,
    tickSize,
  };
}
