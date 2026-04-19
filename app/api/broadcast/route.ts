import { NextRequest, NextResponse } from 'next/server';
import { broadcastTransaction, waitForReceipt } from '@/src/lib/rpc';
import type { ReceiptSummary } from '@/src/lib/types';

/**
 * POST /api/broadcast
 * Broadcast signed transaction to network
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { signedTransaction } = body as { signedTransaction: string };

    if (!signedTransaction || typeof signedTransaction !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid signedTransaction' },
        { status: 400 }
      );
    }

    // Broadcast transaction
    const { txHash, explorerUrl } = await broadcastTransaction(signedTransaction);

    // Wait for receipt (with timeout)
    let receipt: ReceiptSummary | null = null;
    try {
      const txReceipt = await Promise.race([
        waitForReceipt(txHash, 1),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30000)), // 30s timeout
      ]);

      if (txReceipt && txReceipt.blockNumber !== null) {
        receipt = {
          txHash,
          blockNumber: txReceipt.blockNumber,
          gasUsed: txReceipt.gasUsed.toString(),
          status: txReceipt.status === 1 ? 'success' : 'failed',
          explorerUrl,
          fromToken: '', // Will be filled by client
          toToken: '', // Will be filled by client
          amountIn: '', // Will be filled by client
          amountOut: '', // Will be filled by client
        };
      }
    } catch (error) {
      console.warn('Receipt wait error:', error);
      // Continue without receipt
    }

    return NextResponse.json({
      txHash,
      explorerUrl,
      receipt,
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
