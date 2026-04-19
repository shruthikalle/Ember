/**
 * Token configuration for Base mainnet
 *
 * All tokens listed here are verified ERC-20 contracts on Base (chain 8453)
 * with confirmed Uniswap V3/V4 pool liquidity.
 */

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  chainId: number;
}

// Chain ID — read from env so every module agrees on the same chain.
// CHAIN_ID env: 8453 = Base Mainnet, 84532 = Base Sepolia
export const BASE_CHAIN_ID = parseInt(process.env.CHAIN_ID || process.env.NEXT_PUBLIC_CHAIN_ID || '8453', 10);

// Default to Base for blockchain operations
export const CHAIN_ID = BASE_CHAIN_ID;

// ─── Token addresses on Base ───────────────────────────────────────────────
// Verified on https://basescan.org
export const TOKENS: Record<string, TokenInfo> = {
  // ─── Native + wrapped ETH ────────────────────────────────────────────────
  ETH: {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH',
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  },
  WETH: {
    address: process.env.NEXT_PUBLIC_WETH_ADDRESS || '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  },

  // ─── Stablecoins ─────────────────────────────────────────────────────────
  USDC: {
    address: process.env.NEXT_PUBLIC_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    decimals: 6,
    chainId: BASE_CHAIN_ID,
  },
  DAI: {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    symbol: 'DAI',
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  },
  USDT: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    symbol: 'USDT',
    decimals: 6,
    chainId: BASE_CHAIN_ID,
  },

  // ─── BTC (Coinbase wrapped) ──────────────────────────────────────────────
  CBBTC: {
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    symbol: 'cbBTC',
    decimals: 8,
    chainId: BASE_CHAIN_ID,
  },

  // ─── Base ecosystem ──────────────────────────────────────────────────────
  AERO: {
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    symbol: 'AERO',
    decimals: 18,
    chainId: BASE_CHAIN_ID,
  },
};

/**
 * Get token info by symbol
 */
export function getToken(symbol: string): TokenInfo | null {
  const upperSymbol = symbol.toUpperCase();
  return TOKENS[upperSymbol] || null;
}

/**
 * Normalize token symbol — resolve common aliases
 */
export function normalizeTokenSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  const ALIASES: Record<string, string> = {
    BITCOIN: 'CBBTC',
    BTC: 'CBBTC',
    WBTC: 'CBBTC',
    TETHER: 'USDT',
    SOLANA: 'SOL',
  };
  return ALIASES[upper] || upper;
}

// ─── Solana-native tokens (swapped via Jupiter, not Uniswap) ──────────────
// These don't have Base ERC-20 addresses — they live on Solana.
// The SOLANA_TOKENS set is used for routing: if a symbol is here,
// the execute endpoint sends the swap to Jupiter instead of Uniswap.
export const SOLANA_TOKENS = new Set(['SOL', 'BONK', 'JUP', 'WIF', 'PYTH']);

/**
 * Check if token is in allowlist (Base ERC-20 OR Solana via Jupiter)
 */
export function isTokenAllowed(symbol: string): boolean {
  const norm = normalizeTokenSymbol(symbol);
  return getToken(norm) !== null || SOLANA_TOKENS.has(norm);
}

/**
 * Look up a token from the local registry. Returns null for unknown tokens.
 */
export async function searchTokenAddress(tokenSymbol: string): Promise<TokenInfo | null> {
  const normalizedSymbol = normalizeTokenSymbol(tokenSymbol);
  const existing = getToken(normalizedSymbol);
  if (existing && existing.address && existing.address !== '') {
    return existing;
  }
  console.warn(`[Token Search] Unknown token: ${normalizedSymbol}`);
  return null;
}
