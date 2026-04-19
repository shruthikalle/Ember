/**
 * Polymarket CLOB API Client (server-side)
 *
 * Handles order construction, order book queries, order submission,
 * API key derivation, and HMAC signing for the Polymarket CLOB.
 *
 * Aligned with official Polymarket CLOB documentation:
 *   - Order format: salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
 *     expiration, nonce, feeRateBps, side, signatureType
 *   - Market orders: FOK with price as worst-price limit
 *   - BUY: amount = dollar spend, price = max price per share
 *   - SELL: amount = shares to sell, price = min price per share
 *   - Tick sizes: 0.01, 0.001, 0.0001 depending on market
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { PolymarketOrderMessage, PolymarketApiCreds } from './types';

// ─── Constants ──────────────────────────────────────────────────────────────

const CLOB_BASE = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

// Contract addresses (Polygon mainnet)
export const CONTRACTS = {
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  NEG_RISK_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
} as const;

// EIP-712 domain for Polymarket CTF Exchange orders
const CTF_EXCHANGE_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: CONTRACTS.CTF_EXCHANGE,
};

const NEG_RISK_EXCHANGE_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
  verifyingContract: CONTRACTS.NEG_RISK_EXCHANGE,
};

// EIP-712 types for order signing
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

// EIP-712 types for API key derivation
const AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: POLYGON_CHAIN_ID,
};

const AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

// ─── Tick Size ──────────────────────────────────────────────────────────────

/**
 * Fetch the tick size for a given token ID from the CLOB.
 * Returns 0.01, 0.001, or 0.0001.
 */
export async function getTickSize(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${CLOB_BASE}/tick-size?token_id=${tokenId}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return 0.01; // default
    const data = await res.json();
    return parseFloat(data.minimum_tick_size || '0.01');
  } catch {
    return 0.01;
  }
}

/**
 * Round a price to the nearest valid tick size.
 */
export function roundToTick(price: number, tickSize: number): number {
  const decimals = Math.round(-Math.log10(tickSize));
  return parseFloat(price.toFixed(decimals));
}

// ─── Order Book ─────────────────────────────────────────────────────────────

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
}

/**
 * Fetch the order book for a given CLOB token ID.
 */
export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB order book error (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Get the best available price for a BUY or SELL.
 * BUY → best ask (lowest sell price)
 * SELL → best bid (highest buy price)
 */
export function getBestPrice(book: OrderBook, side: 'BUY' | 'SELL'): number | null {
  if (side === 'BUY') {
    const sorted = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    return sorted.length > 0 ? parseFloat(sorted[0].price) : null;
  } else {
    const sorted = [...book.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    return sorted.length > 0 ? parseFloat(sorted[0].price) : null;
  }
}

// ─── Order Construction ─────────────────────────────────────────────────────

/**
 * Build an unsigned EIP-712 order message for Polymarket.
 *
 * Per official docs:
 * - BUY side (0): maker pays USDC, receives outcome tokens
 *   makerAmount = raw USDC amount (6 decimals)
 *   takerAmount = raw shares to receive (6 decimals)
 *   price = makerAmount / takerAmount (in human terms: USD per share)
 *
 * - SELL side (1): maker pays outcome tokens, receives USDC
 *   makerAmount = raw shares to sell (6 decimals)
 *   takerAmount = raw USDC to receive (6 decimals)
 *   price = takerAmount / makerAmount (in human terms: USD per share)
 */
export function buildOrderMessage(params: {
  maker: string;
  tokenId: string;
  amountUsd: number;
  price: number;
  side: 'BUY' | 'SELL';
  feeRateBps?: number;
  nonce?: string;
  tickSize?: number;
}): PolymarketOrderMessage {
  const { maker, tokenId, amountUsd, price, side, feeRateBps = 0, nonce = '0', tickSize = 0.01 } = params;

  // Generate random salt
  const salt = BigInt('0x' + crypto.randomBytes(32).toString('hex')).toString();

  // Round price to tick size
  const roundedPrice = roundToTick(price, tickSize);

  // USDC.e has 6 decimals, CTF shares have 6 decimals
  const DECIMALS = 6;
  const UNIT = 10 ** DECIMALS;

  let makerAmount: string;
  let takerAmount: string;

  if (side === 'BUY') {
    // BUY: maker gives USDC, taker gives shares
    // For a market order: amountUsd is the total spend
    // shares = amountUsd / price
    const rawUsd = Math.round(amountUsd * UNIT);
    const rawShares = Math.round((amountUsd / roundedPrice) * UNIT);
    makerAmount = rawUsd.toString();
    takerAmount = rawShares.toString();
  } else {
    // SELL: maker gives shares, taker gives USDC
    // amountUsd here means dollar equivalent to sell
    const rawShares = Math.round((amountUsd / roundedPrice) * UNIT);
    const rawUsd = Math.round(amountUsd * UNIT);
    makerAmount = rawShares.toString();
    takerAmount = rawUsd.toString();
  }

  return {
    salt,
    maker,
    signer: maker,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId,
    makerAmount,
    takerAmount,
    expiration: '0',
    nonce,
    feeRateBps: feeRateBps.toString(),
    side,
    signatureType: 0, // EOA signature
  };
}

/**
 * Build the EIP-712 typed data object for wallet `eth_signTypedData_v4`.
 */
export function buildOrderTypedData(order: PolymarketOrderMessage, negRisk: boolean) {
  const domain = negRisk ? NEG_RISK_EXCHANGE_DOMAIN : CTF_EXCHANGE_DOMAIN;

  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...ORDER_TYPES,
    },
    primaryType: 'Order' as const,
    domain,
    message: {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side === 'BUY' ? '0' : '1',
      signatureType: String(order.signatureType),
    },
  };
}

/**
 * Build the EIP-712 auth typed data for API key derivation.
 */
export function buildAuthTypedData(address: string, timestamp: string, nonce: number) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      ...AUTH_TYPES,
    },
    primaryType: 'ClobAuth' as const,
    domain: AUTH_DOMAIN,
    message: {
      address,
      timestamp,
      nonce: String(nonce),
      message: 'This message attests that I control the given wallet',
    },
  };
}

// ─── HMAC Signing ───────────────────────────────────────────────────────────

/**
 * Compute HMAC headers for authenticated CLOB API requests.
 * Per Polymarket docs: HMAC-SHA256(timestamp + method + path + body)
 */
export function buildHmacHeaders(
  creds: PolymarketApiCreds,
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + (body || '');
  const signature = crypto
    .createHmac('sha256', Buffer.from(creds.apiSecret, 'base64'))
    .update(message)
    .digest('base64');

  return {
    'POLY-ADDRESS': '',
    'POLY-SIGNATURE': signature,
    'POLY-TIMESTAMP': timestamp,
    'POLY-API-KEY': creds.apiKey,
    'POLY-PASSPHRASE': creds.apiPassphrase,
  };
}

// ─── API Key Derivation ─────────────────────────────────────────────────────

/**
 * Derive CLOB API credentials from a signed auth message.
 */
export async function deriveApiKey(params: {
  address: string;
  signature: string;
  timestamp: string;
  nonce: number;
}): Promise<PolymarketApiCreds> {
  const res = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: params.address,
      signature: params.signature,
      timestamp: params.timestamp,
      nonce: params.nonce,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CLOB auth error (${res.status}): ${text}`);
  }

  return res.json();
}

// ─── Order Submission ───────────────────────────────────────────────────────

interface OrderSubmissionResult {
  success: boolean;
  errorMsg?: string;
  orderID?: string;
  transactID?: string;
  status?: string;
}

/**
 * Submit a signed order to the CLOB.
 *
 * Per Polymarket docs, the POST /order body is:
 * {
 *   order: { salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
 *            expiration, nonce, feeRateBps, side, signatureType },
 *   signature: "0x...",
 *   owner: "0x...",
 *   orderType: "FOK" | "GTC" | "GTD"
 * }
 */
export async function submitOrder(params: {
  order: PolymarketOrderMessage;
  signature: string;
  creds: PolymarketApiCreds;
  owner: string;
  orderType?: 'FOK' | 'GTC' | 'GTD';
}): Promise<OrderSubmissionResult> {
  const { order, signature, creds, owner, orderType = 'FOK' } = params;
  const path = '/order';

  const payload: any = {
    order: {
      salt: parseInt(order.salt),
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side === 'BUY' ? 0 : 1,
      signatureType: order.signatureType,
    },
    signature,
    owner,
    orderType,
  };

  const bodyStr = JSON.stringify(payload);

  console.log('[CLOB] Submitting order:', JSON.stringify(payload, null, 2));

  const hmacHeaders = buildHmacHeaders(creds, 'POST', path, bodyStr);

  const res = await fetch(`${CLOB_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...hmacHeaders,
    },
    body: bodyStr,
  });

  const text = await res.text();
  console.log('[CLOB] Response status:', res.status, 'body:', text);

  if (!res.ok) {
    return { success: false, errorMsg: `CLOB order error (${res.status}): ${text}` };
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { success: false, errorMsg: `CLOB returned non-JSON: ${text}` };
  }

  return {
    success: true,
    orderID: data.orderID,
    transactID: data.transactID,
    status: data.status,
  };
}

// ─── Approval Checks ────────────────────────────────────────────────────────

const ERC20_ABI = ['function allowance(address,address) view returns (uint256)'];
const ERC1155_ABI = ['function isApprovedForAll(address,address) view returns (bool)'];

/**
 * Check if USDC.e approval is needed for the exchange and build approval tx if so.
 */
export async function checkUsdcApproval(
  walletAddress: string,
  amountRaw: string,
  negRisk: boolean,
): Promise<{ needed: boolean; tx?: { to: string; data: string } }> {
  const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdc = new ethers.Contract(CONTRACTS.USDC_E, ERC20_ABI, provider);
  const exchange = negRisk ? CONTRACTS.NEG_RISK_EXCHANGE : CONTRACTS.CTF_EXCHANGE;

  const allowance: bigint = await usdc.allowance(walletAddress, exchange);
  const needed = allowance < BigInt(amountRaw);

  if (!needed) return { needed: false };

  // Build unlimited approval tx
  const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  const data = iface.encodeFunctionData('approve', [exchange, ethers.MaxUint256]);

  return {
    needed: true,
    tx: { to: CONTRACTS.USDC_E, data },
  };
}

/**
 * Check if CTF setApprovalForAll is needed for the exchange.
 */
export async function checkCtfApproval(
  walletAddress: string,
  negRisk: boolean,
): Promise<{ needed: boolean; tx?: { to: string; data: string } }> {
  const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const ctf = new ethers.Contract(CONTRACTS.CTF, ERC1155_ABI, provider);
  const exchange = negRisk ? CONTRACTS.NEG_RISK_EXCHANGE : CONTRACTS.CTF_EXCHANGE;

  const approved: boolean = await ctf.isApprovedForAll(walletAddress, exchange);
  if (approved) return { needed: false };

  const iface = new ethers.Interface(['function setApprovalForAll(address,bool)']);
  const data = iface.encodeFunctionData('setApprovalForAll', [exchange, true]);

  return {
    needed: true,
    tx: { to: CONTRACTS.CTF, data },
  };
}
