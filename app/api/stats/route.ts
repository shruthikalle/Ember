/**
 * GET /api/stats
 *
 * Public endpoint returning agent dashboard stats:
 *   - Agent address + balances (ETH, USDC)
 *   - Cumulative gas spend, compute spend, net profit
 *   - Counts (trades, failed trades)
 *   - Recent 20 trades
 */

import { NextResponse } from 'next/server';
import { getAgentAddress, getEthBalance, getUsdcBalance, getExplorerBaseUrl } from '@/src/lib/wallet';
import { getTotals, getRecentTrades } from '@/src/lib/db';

export const dynamic = 'force-dynamic'; // never cache

export async function GET() {
  try {
    // Gracefully handle missing AGENT_PRIVATE_KEY env var — home page
    // should still render with empty balances / placeholder address.
    let agentAddress = '0x0000000000000000000000000000000000000000';
    let explorerBase = 'https://basescan.org';
    let hasAgent = false;
    try {
      agentAddress = getAgentAddress();
      explorerBase = getExplorerBaseUrl();
      hasAgent = true;
    } catch {
      console.warn('[Stats] AGENT_PRIVATE_KEY not set — returning placeholder stats');
    }

    let ethBal = '0';
    let usdcBal = '0';

    if (hasAgent) {
      try {
        ethBal = await getEthBalance();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimit = errMsg.includes('rate limit') || errMsg.includes('over rate limit');
        console.warn(`[Stats] ETH balance fetch failed${isRateLimit ? ' (rate limited)' : ''}:`, errMsg.slice(0, 100));
      }

      await new Promise((r) => setTimeout(r, 200));

      try {
        usdcBal = await getUsdcBalance();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimit = errMsg.includes('rate limit') || errMsg.includes('over rate limit');
        console.warn(`[Stats] USDC balance fetch failed${isRateLimit ? ' (rate limited)' : ''}:`, errMsg.slice(0, 100));
      }
    }

    // DB aggregates + recent records — also wrapped so a DB issue doesn't 500
    let totals: any = {
      gas_spend_usd: 0, compute_spend_usd: 0, net_profit_usd: 0,
      trade_count: 0, failed_trade_count: 0,
    };
    let recentTrades: any[] = [];
    try {
      totals = getTotals();
      recentTrades = getRecentTrades(20);
    } catch (err) {
      console.warn('[Stats] DB read failed:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json({
      agent_address: agentAddress,
      explorer_url: `${explorerBase}/address/${agentAddress}`,
      balances: { eth: ethBal, usdc: usdcBal },
      totals,
      recent_trades: recentTrades,
    });
  } catch (err) {
    console.error('[Stats] Unhandled error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
