/**
 * Mock swap adapter.
 *
 * Sends a 0-value self-transaction (agent → agent) with a stub calldata
 * payload.  Builder code suffix will be appended by the caller.
 *
 * Activated when MOCK_SWAP=true.
 */

import type { TradeIntent } from '../types';
import type { RouterAdapter, SwapTxResult } from './adapter';
import { getChainId } from '../wallet';
import { ethers } from 'ethers';

export class MockSwapAdapter implements RouterAdapter {
  async buildSwapTx(intent: TradeIntent, agentAddress: string): Promise<SwapTxResult> {
    // Encode a recognisable stub payload
    const stub = ethers.hexlify(
      ethers.toUtf8Bytes(
        `MOCK_SWAP:${intent.tokenInSymbol}->${intent.tokenOutSymbol}:${intent.amountUsd ?? intent.amountToken}`,
      ),
    );

    return {
      to: agentAddress,     // self-tx
      data: stub,
      value: '0x0',
      chainId: getChainId(),
    };
  }
}
