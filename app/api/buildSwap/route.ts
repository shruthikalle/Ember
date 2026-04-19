import { NextRequest, NextResponse } from 'next/server';
import { TradeIntent, TradeIntentSchema, Quote, BuildSwapTx } from '@/src/lib/types';
import { validateTradeIntent, checkGuardrails } from '@/src/lib/policy';
import { buildSwapTransaction } from '@/src/lib/uniswap';
import { appendBuilderCodeSuffix, getBuilderCode } from '@/src/lib/builderCode';

/**
 * POST /api/buildSwap
 * Build swap transaction ready to sign
 */
export async function POST(request: NextRequest) {
  try {
    // Read body once
    const body = await request.json();
    const { intent, quote, walletAddress } = body as {
      intent: TradeIntent;
      quote: Quote;
      walletAddress: string;
    };

    console.log('[API BuildSwap] ========================================');
    console.log('[API BuildSwap] Received build request:');
    console.log('[API BuildSwap] Intent:', JSON.stringify(intent, null, 2));
    console.log('[API BuildSwap] Quote:', {
      amountIn: quote.amountInFormatted,
      amountOut: quote.amountOutFormatted,
      minAmountOut: quote.minAmountOutFormatted,
      slippageBps: quote.slippageBps,
    });
    console.log('[API BuildSwap] Wallet Address:', walletAddress);

    // Validate intent
    const parseResult = TradeIntentSchema.safeParse(intent);
    if (!parseResult.success) {
      console.error('[API BuildSwap] ❌ Intent validation failed:', parseResult.error.issues);
      return NextResponse.json(
        { error: 'Invalid trade intent', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const validatedIntent = parseResult.data;
    console.log('[API BuildSwap] ✅ Intent validated');

    // Validate policy
    console.log('[API BuildSwap] Validating trade intent against policy...');
    const validation = validateTradeIntent(validatedIntent);
    if (!validation.valid) {
      console.error('[API BuildSwap] ❌ Policy validation failed:', validation.errors);
      return NextResponse.json(
        { error: 'Trade intent validation failed', details: validation.errors },
        { status: 400 }
      );
    }
    console.log('[API BuildSwap] ✅ Policy validation passed');

    // Check guardrails against quote
    console.log('[API BuildSwap] Checking guardrails...');
    const guardrails = checkGuardrails(validatedIntent, quote);
    if (!guardrails.passed) {
      console.error('[API BuildSwap] ❌ Guardrails check failed:', guardrails.errors);
      if (guardrails.warnings && guardrails.warnings.length > 0) {
        console.warn('[API BuildSwap] Warnings:', guardrails.warnings);
      }
      return NextResponse.json(
        { error: 'Guardrails check failed', details: guardrails.errors },
        { status: 400 }
      );
    }
    if (guardrails.warnings && guardrails.warnings.length > 0) {
      console.warn('[API BuildSwap] ⚠️ Guardrail warnings:', guardrails.warnings);
    }
    console.log('[API BuildSwap] ✅ Guardrails check passed');

    if (!walletAddress) {
      console.error('[API BuildSwap] ❌ Wallet address missing');
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    // Build transaction
    console.log('[API BuildSwap] Building swap transaction...');
    const txRequest = await buildSwapTransaction(validatedIntent, quote, walletAddress);
    
    // ── Append ERC-8021 Builder Code suffix ──────────────────────────────────
    const builderCode = getBuilderCode();
    const dataWithSuffix = appendBuilderCodeSuffix(txRequest.data, builderCode);
    
    // Also append to approval transactions if they exist
    const approvalTransactions = txRequest.approvalTransactions?.map(approval => ({
      ...approval,
      data: appendBuilderCodeSuffix(approval.data, builderCode),
    }));
    
    const approvalTransaction = txRequest.approvalTransaction
      ? {
          ...txRequest.approvalTransaction,
          data: appendBuilderCodeSuffix(txRequest.approvalTransaction.data, builderCode),
        }
      : undefined;
    
    const txRequestWithBuilderCode: BuildSwapTx = {
      ...txRequest,
      data: dataWithSuffix,
      approvalTransactions,
      approvalTransaction,
    };
    
    console.log('[API BuildSwap] ✅ Transaction built:');
    console.log('[API BuildSwap]   - To:', txRequestWithBuilderCode.to);
    console.log('[API BuildSwap]   - Chain ID:', txRequestWithBuilderCode.chainId);
    console.log('[API BuildSwap]   - Data length:', txRequest.data.length, '→', dataWithSuffix.length, 'chars');
    console.log('[API BuildSwap]   - Value:', txRequestWithBuilderCode.value);
    console.log('[API BuildSwap]   - Builder Code:', builderCode || '(none configured)');
    if (builderCode) {
      // Log the last 32 chars of data to verify suffix is present
      const dataEnd = dataWithSuffix.slice(-32).toLowerCase();
      console.log('[API BuildSwap]   - Data ends with:', dataEnd);
      console.log('[API BuildSwap]   - Expected 8021 pattern:', dataEnd.includes('8021') ? '✅ Found' : '❌ Missing');
    }
    if (txRequestWithBuilderCode.gas) {
      console.log('[API BuildSwap]   - Gas:', txRequestWithBuilderCode.gas);
    }
    console.log('[API BuildSwap] ========================================');

    return NextResponse.json(txRequestWithBuilderCode);
  } catch (error) {
    console.error('Build swap error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
