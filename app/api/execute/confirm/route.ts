/**
 * POST /api/execute/confirm
 *
 * After the user signs and broadcasts the swap tx from their wallet,
 * they call this endpoint with the trade_id + tx_hash so we can
 * track it in the DB and update stats.
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateTradeStatus } from '@/src/lib/db';
import { getProvider, getExplorerBaseUrl } from '@/src/lib/wallet';
import { estimateGasCostUsd } from '@/src/lib/pricing';
import { verifyBuilderSuffix } from '@/src/lib/builderCode';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { trade_id, tx_hash } = body as {
      trade_id?: string;
      tx_hash?: string;
    };

    if (!trade_id || !tx_hash) {
      return NextResponse.json(
        { error: 'Missing trade_id or tx_hash' },
        { status: 400 },
      );
    }

    console.log('[Confirm] ═══════════════════════════════════════════');
    console.log('[Confirm] trade_id:', trade_id);
    console.log('[Confirm] tx_hash:', tx_hash);

    // Try to fetch the receipt
    const provider = getProvider();
    let status = 'confirmed';
    let gasUsed = '0';
    let gasCostUsd = 0;
    let builderCodeVerified = false;

    try {
      const receipt = await provider.getTransactionReceipt(tx_hash);
      if (receipt) {
        status = receipt.status === 1 ? 'success' : 'failed';
        gasUsed = receipt.gasUsed.toString();
        const gasPrice = receipt.gasPrice;
        if (gasPrice) {
          gasCostUsd = estimateGasCostUsd(receipt.gasUsed, gasPrice);
        }
      }

      // Verify builder code suffix on the actual tx data
      const tx = await provider.getTransaction(tx_hash);
      if (tx?.data) {
        builderCodeVerified = verifyBuilderSuffix(tx.data);
      }
    } catch (err) {
      console.warn('[Confirm] Could not fetch receipt (tx may be pending):', err instanceof Error ? err.message : err);
      status = 'pending';
    }

    // Update the trade record
    updateTradeStatus(trade_id, {
      status,
      trade_tx_hash: tx_hash,
      gas_used: gasUsed,
      gas_cost_usd: gasCostUsd,
    });

    const explorerBase = getExplorerBaseUrl();

    console.log('[Confirm] Status:', status);
    console.log('[Confirm] Builder code verified:', builderCodeVerified);
    console.log('[Confirm] ═══════════════════════════════════════════');

    return NextResponse.json({
      trade_id,
      tx_hash,
      status,
      gas_used: gasUsed,
      gas_cost_usd: gasCostUsd,
      builder_code_verified: builderCodeVerified,
      explorer_url: `${explorerBase}/tx/${tx_hash}`,
    });
  } catch (err) {
    console.error('[Confirm] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
