import { TradeIntent, Quote, ValidationResult, GuardrailResult } from './types';
import { isTokenAllowed, normalizeTokenSymbol } from './tokens';
import { getChainId } from './rpc';

const MAX_TRADE_SIZE_USD = parseFloat(process.env.NEXT_PUBLIC_MAX_TRADE_SIZE_USD || '250');
const MAX_SLIPPAGE_BPS = parseInt(process.env.NEXT_PUBLIC_MAX_SLIPPAGE_BPS || '100', 10);
const MAX_DEADLINE_MINUTES = 10;

/**
 * Validate trade intent structure and basic constraints
 */
export function validateTradeIntent(intent: TradeIntent): ValidationResult {
  const errors: string[] = [];

  // Check chain ID (must be Base for Uniswap)
  if (intent.chainId !== getChainId()) {
    errors.push(`Invalid chainId. Only Base (${getChainId()}) is allowed for Uniswap transactions.`);
  }

  // Check token allowlist
  const tokenIn = normalizeTokenSymbol(intent.tokenInSymbol);
  const tokenOut = normalizeTokenSymbol(intent.tokenOutSymbol);

  if (!isTokenAllowed(tokenIn)) {
    errors.push(`Token not allowed: ${intent.tokenInSymbol}. Supported: ETH, USDC, DAI, USDT, cbBTC, AERO, SOL, BONK, JUP, WIF.`);
  }

  if (!isTokenAllowed(tokenOut)) {
    errors.push(`Token not allowed: ${intent.tokenOutSymbol}. Supported: ETH, USDC, DAI, USDT, cbBTC, AERO, SOL, BONK, JUP, WIF.`);
  }

  // Check amount is provided
  if (!intent.amountUsd && !intent.amountToken) {
    errors.push('Either amountUsd or amountToken must be provided.');
  }

  // Check slippage (skip for SEND — no slippage on transfers)
  if (intent.side !== 'SEND' && (intent.slippageBps < 0 || intent.slippageBps > MAX_SLIPPAGE_BPS)) {
    errors.push(`Slippage must be between 0 and ${MAX_SLIPPAGE_BPS} bps (${MAX_SLIPPAGE_BPS / 100}%).`);
  }

  // Check recipient for SEND
  if (intent.side === 'SEND' && !intent.recipientAddress) {
    errors.push('Recipient address is required for transfers.');
  }

  // Check USD amount if provided
  if (intent.amountUsd && intent.amountUsd > MAX_TRADE_SIZE_USD) {
    errors.push(`Trade size $${intent.amountUsd} exceeds maximum of $${MAX_TRADE_SIZE_USD}.`);
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Check guardrails against quote
 */
export function checkGuardrails(intent: TradeIntent, quote: Quote): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check slippage
  if (quote.slippageBps > MAX_SLIPPAGE_BPS) {
    errors.push(`Slippage ${quote.slippageBps} bps exceeds maximum of ${MAX_SLIPPAGE_BPS} bps.`);
  }

  // Check price impact (if available)
  if (quote.priceImpact) {
    const impact = parseFloat(quote.priceImpact);
    if (impact > 5) {
      warnings.push(`High price impact: ${impact.toFixed(2)}%`);
    }
  }

  // Check USD value if we can calculate it
  if (intent.amountUsd && intent.amountUsd > MAX_TRADE_SIZE_USD) {
    errors.push(`Trade size exceeds maximum of $${MAX_TRADE_SIZE_USD}.`);
  }

  return {
    passed: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Calculate deadline (10 minutes from now)
 */
export function calculateDeadline(): number {
  return Math.floor(Date.now() / 1000) + MAX_DEADLINE_MINUTES * 60;
}

/**
 * Get max trade size
 */
export function getMaxTradeSizeUsd(): number {
  return MAX_TRADE_SIZE_USD;
}

/**
 * Get max slippage in bps
 */
export function getMaxSlippageBps(): number {
  return MAX_SLIPPAGE_BPS;
}
