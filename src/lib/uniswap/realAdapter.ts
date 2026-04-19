/**
 * Real Uniswap adapter.
 *
 * Wraps the existing hybrid V3+V4 swap builder in src/lib/uniswap.ts
 * and adapts it to the RouterAdapter interface.
 *
 * Includes retry logic with exponential backoff for RPC rate-limit errors
 * (Infura / Alchemy 429s, -32005, etc.).
 */

import type { TradeIntent } from '../types';
import type { RouterAdapter, SwapTxResult } from './adapter';
import { getQuote, buildSwapTransaction } from '../uniswap';
import { getChainId } from '../wallet';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2 seconds, doubles each retry

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Too Many Requests') ||
    msg.includes('-32005') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('BAD_DATA') // ethers wraps mixed batch responses as BAD_DATA
  );
}

export class RealSwapAdapter implements RouterAdapter {
  async buildSwapTx(intent: TradeIntent, agentAddress: string): Promise<SwapTxResult> {
    const chainId = getChainId();
    const adjustedIntent: TradeIntent = { ...intent, chainId };

    console.log('[RealAdapter] Getting quote for', adjustedIntent.tokenInSymbol, '->', adjustedIntent.tokenOutSymbol);

    // ── Quote with retry ──────────────────────────────────────────────────
    let quote;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        quote = await getQuote(adjustedIntent, agentAddress);
        break;
      } catch (err) {
        if (isRateLimitError(err) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`[RealAdapter] Quote rate-limited (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms…`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
    if (!quote) throw new Error('Failed to get quote after retries');

    console.log('[RealAdapter] Quote:', quote.amountInFormatted, adjustedIntent.tokenInSymbol,
      '->', quote.amountOutFormatted, adjustedIntent.tokenOutSymbol);

    // ── Build swap tx with retry ──────────────────────────────────────────
    let swapTx;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        swapTx = await buildSwapTransaction(adjustedIntent, quote, agentAddress);
        break;
      } catch (err) {
        if (isRateLimitError(err) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`[RealAdapter] Build rate-limited (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms…`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
    if (!swapTx) throw new Error('Failed to build swap tx after retries');

    console.log('[RealAdapter] SwapTx built: to=', swapTx.to, 'value=', swapTx.value);

    // ── Handle approvals server-side if needed ────────────────────────────
    if (swapTx.needsApproval && swapTx.approvalTransactions?.length) {
      console.log('[RealAdapter] Approvals needed:', swapTx.approvalTransactions.length);
      (this as any)._pendingApprovals = swapTx.approvalTransactions;
    }

    return {
      to: swapTx.to,
      data: swapTx.data,
      value: swapTx.value,
      chainId,
    };
  }
}
