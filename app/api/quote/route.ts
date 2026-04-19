import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { TradeIntent, TradeIntentSchema, Quote } from '@/src/lib/types';
import { validateTradeIntent } from '@/src/lib/policy';
import { getQuote } from '@/src/lib/uniswap';

/**
 * POST /api/quote
 * Get quote for a trade intent
 */
export async function POST(request: NextRequest) {
  try {
    // x402 payments disabled for MetaMask-only mode

    const body = await request.json();
    console.log('[API Quote] ========================================');
    console.log('[API Quote] Received request body:', JSON.stringify(body, null, 2));
    
    // Extract intent from body (frontend sends { intent: TradeIntent, walletAddress: string })
    const intent = (body.intent || body) as TradeIntent;
    
    console.log('[API Quote] Extracted intent:');
    console.log('[API Quote]   - Side:', intent.side);
    console.log('[API Quote]   - Token In:', intent.tokenInSymbol);
    console.log('[API Quote]   - Token Out:', intent.tokenOutSymbol);
    console.log('[API Quote]   - Amount USD:', intent.amountUsd || 'N/A');
    console.log('[API Quote]   - Amount Token:', intent.amountToken || 'N/A');
    console.log('[API Quote]   - Slippage:', intent.slippageBps, 'bps');
    console.log('[API Quote]   - Chain ID:', intent.chainId);
    console.log('[API Quote] Full intent:', JSON.stringify(intent, null, 2));

    // Validate intent structure
    const parseResult = TradeIntentSchema.safeParse(intent);
    if (!parseResult.success) {
      console.error('[API Quote] ❌ Intent validation failed:', parseResult.error.issues);
      return NextResponse.json(
        { error: 'Invalid trade intent', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const validatedIntent = parseResult.data;
    console.log('[API Quote] ✅ Intent validated successfully');

    // Validate policy
    console.log('[API Quote] Validating trade intent against policy...');
    const validation = validateTradeIntent(validatedIntent);
    if (!validation.valid) {
      console.error('[API Quote] ❌ Policy validation failed:', validation.errors);
      return NextResponse.json(
        { error: 'Trade intent validation failed', details: validation.errors },
        { status: 400 }
      );
    }
    console.log('[API Quote] ✅ Policy validation passed');

    // Get wallet address from request body (frontend sends it as walletAddress)
    const walletAddress = body.walletAddress || '0x0000000000000000000000000000000000000000';
    console.log('[API Quote] Wallet address:', walletAddress);
    
    // Log wallet ETH balance
    if (walletAddress && walletAddress !== '0x0000000000000000000000000000000000000000') {
      try {
        const { getProviderWithRetry } = await import('@/src/lib/rpc');
        const provider = await getProviderWithRetry();
        
        // Log network info
        const network = await provider.getNetwork();
        console.log('[API Quote] 🌐 Network Info:');
        console.log('[API Quote]   - Network:', network.name);
        console.log('[API Quote]   - Chain ID:', network.chainId.toString());
        const expectedChainId = parseInt(process.env.CHAIN_ID || process.env.NEXT_PUBLIC_CHAIN_ID || '8453', 10);
        console.log('[API Quote]   - Expected Chain ID:', expectedChainId, '(Base)');
        console.log('[API Quote]   - Network Match:', Number(network.chainId) === expectedChainId ? '✅ YES' : '❌ NO');
        
        const balance = await provider.getBalance(walletAddress);
        const balanceFormatted = ethers.formatEther(balance);
        console.log('[API Quote] 💰 Wallet ETH Balance:');
        console.log('[API Quote]   - Address:', walletAddress);
        console.log('[API Quote]   - Balance (raw):', balance.toString());
        console.log('[API Quote]   - Balance (formatted):', balanceFormatted, 'ETH');
        console.log('[API Quote]   - Network:', network.name, '(Chain ID:', network.chainId.toString() + ')');
        
        if (Number(network.chainId) !== expectedChainId) {
          console.warn('[API Quote] ⚠️ WARNING: Wallet balance checked on wrong network!');
          console.warn(`[API Quote]   - Expected: Base (Chain ID: ${expectedChainId})`);
          console.warn('[API Quote]   - Actual:', network.name, '(Chain ID:', network.chainId.toString() + ')');
          console.warn('[API Quote]   - Balance shown may be incorrect for Base operations');
        }
      } catch (error) {
        console.warn('[API Quote] ⚠️ Could not fetch wallet ETH balance:', error);
        if (error instanceof Error) {
          console.warn('[API Quote]   - Error message:', error.message);
          console.warn('[API Quote]   - Error stack:', error.stack);
        }
      }
    } else {
      console.warn('[API Quote] ⚠️ Invalid or missing wallet address, cannot check balance');
    }

    // Get quote
    console.log('[API Quote] Fetching quote from Uniswap...');
    console.log('[API Quote] Calling getQuote with:');
    console.log('[API Quote]   - Intent:', JSON.stringify(validatedIntent, null, 2));
    console.log('[API Quote]   - Wallet Address:', walletAddress);
    
    try {
      const quote = await getQuote(validatedIntent, walletAddress);
      console.log('[API Quote] ✅ Quote received:');
      console.log('[API Quote]   - Amount In:', quote.amountInFormatted, validatedIntent.tokenInSymbol);
      console.log('[API Quote]   - Amount Out:', quote.amountOutFormatted, validatedIntent.tokenOutSymbol);
      console.log('[API Quote]   - Min Amount Out:', quote.minAmountOutFormatted, validatedIntent.tokenOutSymbol);
      console.log('[API Quote]   - Slippage:', quote.slippageBps, 'bps');
      if (quote.gasEstimate) {
        console.log('[API Quote]   - Gas Estimate:', quote.gasEstimate);
      }
      console.log('[API Quote] Full quote object:', JSON.stringify(quote, null, 2));
      console.log('[API Quote] ========================================');

      return NextResponse.json(quote);
    } catch (quoteError) {
      console.error('[API Quote] ❌ Error getting quote:', quoteError);
      console.error('[API Quote] Error type:', quoteError instanceof Error ? quoteError.constructor.name : typeof quoteError);
      console.error('[API Quote] Error message:', quoteError instanceof Error ? quoteError.message : String(quoteError));
      if (quoteError instanceof Error && quoteError.stack) {
        console.error('[API Quote] Error stack:', quoteError.stack);
      }
      
      throw quoteError; // Re-throw to be caught by outer catch
    }
  } catch (error) {
    console.error('[API Quote] ❌ Unexpected error in quote endpoint:', error);
    console.error('[API Quote] Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('[API Quote] Error message:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('[API Quote] Error stack:', error.stack);
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
