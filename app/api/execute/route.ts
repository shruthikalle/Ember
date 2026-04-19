/**
 * POST /api/execute
 *
 * Swap execution endpoint — MODEL B (user signs).
 *
 * Flow:
 *   1. Parse command → build unsigned swap tx + approvals
 *   2. Append builder code (ERC-8021 attribution)
 *   3. Return unsigned tx for user to sign from their own wallet
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

import { parseTradeIntent } from '@/src/lib/llm';
import { validateTradeIntent } from '@/src/lib/policy';
import { appendBuilderCodeSuffix, getBuilderCode, verifyBuilderSuffix } from '@/src/lib/builderCode';
import { buildEvmTransfer, buildSolanaTransfer, isSolanaTransfer } from '@/src/lib/transfer';
import { getAgentAddress, getExplorerBaseUrl, getChainId } from '@/src/lib/wallet';
import { insertTrade } from '@/src/lib/db';
import { estimateComputeCostUsd, estimateTokenCount } from '@/src/lib/pricing';
import { MockSwapAdapter } from '@/src/lib/uniswap/mockAdapter';
import { RealSwapAdapter } from '@/src/lib/uniswap/realAdapter';
import type { RouterAdapter } from '@/src/lib/uniswap/adapter';
import { isSolanaSwap, getJupiterSwap, getSolanaDecimals } from '@/src/lib/jupiter';
import { getEthPriceInUsd } from '@/src/lib/uniswap';
import { getProvider } from '@/src/lib/wallet';
import { getSolPriceInUsd } from '@/src/lib/jupiter';

// ─── Adapter selection ──────────────────────────────────────────────────────

function getAdapter(): RouterAdapter {
  if (process.env.MOCK_SWAP === 'true') {
    console.log('[Execute] Using MOCK swap adapter');
    return new MockSwapAdapter();
  }
  console.log('[Execute] Using REAL Uniswap swap adapter');
  return new RealSwapAdapter();
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // ── Parse body ────────────────────────────────────────────────────────
    const body = await request.json();
    const { command, params, walletAddress } = body as {
      command?: string;
      params?: { slippageBps?: number };
      walletAddress?: string; // User's wallet address for swap building
    };

    if (!command || typeof command !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "command" field' },
        { status: 400 },
      );
    }

    console.log('[Execute] ═══════════════════════════════════════════');
    console.log('[Execute] Command:', command);
    console.log('[Execute] Params:', JSON.stringify(params ?? {}));
    console.log('[Execute] User wallet:', walletAddress || '(not provided)');

    // ── Parse command → TradeIntent ────────────────────────────────────────
    const tokenCount = estimateTokenCount(command);
    const computeCost = estimateComputeCostUsd(tokenCount);

    const parseResult = await parseTradeIntent(command);
    if (!parseResult.intent) {
      return NextResponse.json(
        { error: parseResult.error || 'Failed to parse trade command' },
        { status: 400 },
      );
    }

    const intent = parseResult.intent;

    // Apply optional slippage override
    if (params?.slippageBps !== undefined) {
      intent.slippageBps = params.slippageBps;
    }

    // Override chain ID to match agent config
    intent.chainId = getChainId();

    console.log('[Execute] TradeIntent:', JSON.stringify(intent));

    // ── Validate ──────────────────────────────────────────────────────────
    const validation = validateTradeIntent(intent);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Validation failed: ${validation.errors?.join('; ')}` },
        { status: 400 },
      );
    }

    // ── Create trade ID early (needed by all paths) ───────────────────
    const tradeId = uuidv4();

    // ── SEND / TRANSFER ─────────────────────────────────────────────
    if (intent.side === 'SEND') {
      console.log('[Execute] 📤 Send/Transfer detected');

      if (!intent.recipientAddress) {
        return NextResponse.json(
          { error: 'Recipient address is required for transfers.' },
          { status: 400 },
        );
      }

      // Resolve transfer amount — convert USD → token units if necessary
      let amount: number;
      if (intent.amountToken) {
        amount = intent.amountToken;
      } else if (intent.amountUsd) {
        const tokenUpper = intent.tokenInSymbol.toUpperCase();
        const STABLECOINS = new Set(['USDC', 'USDT', 'DAI']);
        if (STABLECOINS.has(tokenUpper)) {
          // 1 USD ≈ 1 stablecoin token
          amount = intent.amountUsd;
        } else if (tokenUpper === 'ETH' || tokenUpper === 'WETH') {
          const ethPrice = await getEthPriceInUsd(getProvider());
          amount = intent.amountUsd / ethPrice;
          console.log(`[Execute] USD→ETH: $${intent.amountUsd} / $${ethPrice} = ${amount} ETH`);
        } else if (tokenUpper === 'SOL') {
          const solPrice = await getSolPriceInUsd();
          amount = intent.amountUsd / solPrice;
          console.log(`[Execute] USD→SOL: $${intent.amountUsd} / $${solPrice} = ${amount} SOL`);
        } else {
          // Unknown token price — treat amountUsd as token amount (safe fallback)
          console.warn(`[Execute] No price oracle for ${tokenUpper}, using amountUsd as token amount`);
          amount = intent.amountUsd;
        }
      } else {
        amount = 0;
      }
      if (amount <= 0) {
        return NextResponse.json({ error: 'Invalid transfer amount.' }, { status: 400 });
      }

      insertTrade({
        trade_id: tradeId,
        command,
        trade_tx_hash: null,
        status: 'pending',
        gas_used: null,
        gas_cost_usd: null,
        compute_cost_usd: computeCost,
        builder_code: null,
      });

      // Solana transfer
      if (isSolanaTransfer(intent.tokenInSymbol)) {
        const solanaWallet = body.solanaWalletAddress;
        if (!solanaWallet) {
          return NextResponse.json(
            { error: 'Solana wallet required. Please connect Phantom.' },
            { status: 400 },
          );
        }

        try {
          const result = await buildSolanaTransfer(
            intent.tokenInSymbol,
            amount,
            solanaWallet,
            intent.recipientAddress,
          );

          console.log('[Execute] ✅ Solana transfer tx built');
          return NextResponse.json({
            chain: 'solana',
            swapTransaction: result.serializedTransaction,
            trade_id: tradeId,
            intent,
            compute_cost_usd: computeCost,
            message: `Sign to send ${amount} ${intent.tokenInSymbol} to ${intent.recipientAddress.slice(0, 8)}...`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: `Solana transfer failed: ${msg}` }, { status: 500 });
        }
      }

      // EVM transfer (Base)
      try {
        const tx = buildEvmTransfer(
          intent.tokenInSymbol,
          amount,
          intent.recipientAddress,
          getChainId(),
        );

        console.log('[Execute] ✅ EVM transfer tx built');
        return NextResponse.json({
          transaction: tx,
          approvals: [],
          trade_id: tradeId,
          intent,
          compute_cost_usd: computeCost,
          explorer_base: getExplorerBaseUrl(),
          message: `Sign to send ${amount} ${intent.tokenInSymbol} to ${intent.recipientAddress.slice(0, 8)}...`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Transfer failed: ${msg}` }, { status: 500 });
      }
    }

    // ── Check if this is a Solana swap (Jupiter) ──────────────────────
    if (isSolanaSwap(intent.tokenInSymbol, intent.tokenOutSymbol)) {
      console.log('[Execute] 🟣 Solana swap detected — routing to Jupiter');

      const solanaWallet = body.solanaWalletAddress;
      if (!solanaWallet) {
        return NextResponse.json(
          { error: 'Solana wallet required for this swap. Please connect Phantom.' },
          { status: 400 },
        );
      }

      try {
        // Compute raw amount in smallest units
        let amountRaw: string;
        if (intent.amountToken) {
          const decimals = getSolanaDecimals(intent.tokenInSymbol);
          amountRaw = String(Math.round(intent.amountToken * 10 ** decimals));
        } else if (intent.amountUsd) {
          // For USD amounts buying a Solana token, input is USDC (6 decimals)
          amountRaw = String(Math.round(intent.amountUsd * 1_000_000));
        } else {
          return NextResponse.json({ error: 'No amount specified' }, { status: 400 });
        }

        const { quote, swap } = await getJupiterSwap(
          intent.tokenInSymbol,
          intent.tokenOutSymbol,
          amountRaw,
          solanaWallet,
          intent.slippageBps,
        );

        const inDecimals = getSolanaDecimals(intent.tokenInSymbol);
        const outDecimals = getSolanaDecimals(intent.tokenOutSymbol);

        // Record trade
        insertTrade({
          trade_id: tradeId,
          command,
          trade_tx_hash: null,
          status: 'pending',
          gas_used: null,
          gas_cost_usd: null,
          compute_cost_usd: computeCost,
          builder_code: null,
        });

        console.log('[Execute] ✅ Jupiter swap tx built');
        console.log('[Execute] ═══════════════════════════════════════════');

        return NextResponse.json({
          chain: 'solana',
          swapTransaction: swap.swapTransaction,
          lastValidBlockHeight: swap.lastValidBlockHeight,
          trade_id: tradeId,
          intent,
          compute_cost_usd: computeCost,
          quote: {
            inAmount: quote.inAmount,
            outAmount: quote.outAmount,
            inAmountFormatted: `${(parseInt(quote.inAmount) / 10 ** inDecimals).toFixed(6)} ${intent.tokenInSymbol}`,
            outAmountFormatted: `${(parseInt(quote.outAmount) / 10 ** outDecimals).toFixed(6)} ${intent.tokenOutSymbol}`,
            priceImpact: quote.priceImpactPct,
            slippageBps: quote.slippageBps,
          },
          message: 'Sign the Solana transaction with Phantom.',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Execute] Jupiter error:', msg);
        return NextResponse.json(
          { error: `Jupiter swap failed: ${msg}` },
          { status: 500 },
        );
      }
    }

    // ── Determine wallet address for swap building (EVM/Base) ─────────
    // Model B: use the USER's wallet address for building the swap tx.
    // The user will sign and broadcast from their own wallet.
    const swapWallet = walletAddress || getAgentAddress();
    if (!walletAddress) {
      console.warn('[Execute] No walletAddress provided — using agent address as fallback. User should provide their wallet.');
    }

    // ── Create trade record (pending) ────────────────────────────────────
    insertTrade({
      trade_id: tradeId,
      command,
      trade_tx_hash: null,
      status: 'pending',
      gas_used: null,
      gas_cost_usd: null,
      compute_cost_usd: computeCost,
      builder_code: getBuilderCode() || null,
    });

    // ── Build swap tx ────────────────────────────────────────────────────
    const adapter = getAdapter();
    let swapTx;
    let approvalTxs: { to: string; data: string }[] = [];

    try {
      swapTx = await adapter.buildSwapTx(intent, swapWallet);
      // Collect any pending approvals
      const realAdapter = adapter as any;
      if (realAdapter._pendingApprovals?.length > 0) {
        approvalTxs = realAdapter._pendingApprovals;
        console.log('[Execute] Approvals needed:', approvalTxs.length);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Failed to build swap tx: ${msg}` },
        { status: 500 },
      );
    }

    // ── Append builder code suffix ────────────────────────────────────────
    const calldataWithSuffix = appendBuilderCodeSuffix(swapTx.data);
    const builderCode = getBuilderCode();

    // Assertion: verify suffix was appended
    if (builderCode && !verifyBuilderSuffix(calldataWithSuffix)) {
      console.error('[Execute] FATAL: builder code suffix not appended correctly');
      return NextResponse.json(
        { error: 'Internal error: builder code suffix verification failed' },
        { status: 500 },
      );
    }

    console.log('[Execute] Builder code:', builderCode || '(none configured)');
    console.log('[Execute] Calldata length: before=', swapTx.data.length, 'after=', calldataWithSuffix.length);
    if (builderCode) {
      // Log the last 32 chars of data to verify suffix is present
      const dataEnd = calldataWithSuffix.slice(-32).toLowerCase();
      console.log('[Execute] Data ends with:', dataEnd);
      console.log('[Execute] Expected 8021 pattern:', dataEnd.includes('8021') ? '✅ Found' : '❌ Missing');
    }

    const explorerBase = getExplorerBaseUrl();

    console.log('[Execute] ✅ Unsigned tx built for user to sign');
    console.log('[Execute] ═══════════════════════════════════════════');

    // ── Return unsigned transaction for the user to sign ─────────────────
    return NextResponse.json({
      // The unsigned swap transaction — user signs this with their wallet
      transaction: {
        to: swapTx.to,
        data: calldataWithSuffix,
        value: swapTx.value,
        chainId: swapTx.chainId,
      },
      // Approval transactions the user needs to sign first (if any)
      approvals: approvalTxs.map((a) => ({
        to: a.to,
        data: a.data,
        value: '0x0',
      })),
      // Metadata
      trade_id: tradeId,
      builder_code: builderCode || null,
      intent,
      compute_cost_usd: computeCost,
      explorer_base: explorerBase,
      message: approvalTxs.length > 0
        ? `Sign ${approvalTxs.length} approval(s) first, then sign the swap transaction.`
        : 'Sign the swap transaction with your wallet.',
    });
  } catch (err) {
    console.error('[Execute] Unhandled error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
