/**
 * RouterAdapter interface.
 *
 * Abstracts swap transaction building so we can swap between
 * a real Uniswap adapter and a mock (self-tx) adapter.
 */

import type { TradeIntent } from '../types';

export interface SwapTxResult {
  to: string;
  data: string;   // hex calldata (builder suffix NOT yet appended)
  value: string;   // hex native value
  chainId: number;
}

export interface RouterAdapter {
  /**
   * Build a swap transaction for the given intent.
   * Returns raw tx fields (before builder code suffix is appended).
   */
  buildSwapTx(intent: TradeIntent, agentAddress: string): Promise<SwapTxResult>;
}
