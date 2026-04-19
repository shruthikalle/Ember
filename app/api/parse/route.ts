/**
 * POST /api/parse
 * Parse natural language command into TradeIntent
 * Server-side API route that has access to ANTHROPIC_API_KEY
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { TradeIntent, TradeIntentSchema } from '@/src/lib/types';
import { normalizeTokenSymbol, BASE_CHAIN_ID } from '@/src/lib/tokens';
import { getChainId } from '@/src/lib/rpc';

// Lazy-load Claude client
let claudeClient: Anthropic | null = null;

function getClaudeClient(): Anthropic | null {
  console.log('[API Parse] Checking for Claude API key...');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log('[API Parse] ❌ ANTHROPIC_API_KEY not found in process.env');
    return null;
  }

  console.log('[API Parse] ✅ ANTHROPIC_API_KEY found (length:', apiKey.length, 'chars)');

  if (!claudeClient) {
    console.log('[API Parse] Initializing Claude client...');
    try {
      claudeClient = new Anthropic({
        apiKey: apiKey,
      });
      console.log('[API Parse] ✅ Claude client initialized');
    } catch (initError) {
      console.error('[API Parse] ❌ Failed to initialize Claude client:', initError);
      return null;
    }
  } else {
    console.log('[API Parse] Using existing Claude client instance');
  }

  return claudeClient;
}

/**
 * Parse natural language command using LLM
 */
async function parseWithLLM(command: string): Promise<TradeIntent | null> {
  console.log('[API Parse] ===== Starting LLM parse =====');
  console.log('[API Parse] Command:', command);

  const claude = getClaudeClient();
  if (!claude) {
    console.log('[API Parse] ❌ Claude API key not configured, skipping LLM parsing');
    return null;
  }

  console.log('[API Parse] ✅ Claude client available');
  console.log('[API Parse] Attempting to parse command with Claude:', command);

  const chainId = getChainId();
  const systemPrompt = `You are a trading command parser for an AI swap agent on Base chain. Output ONLY valid JSON matching the schema. No prose.

Supported tokens:
- Base chain: ETH, WETH, USDC, DAI, USDT, cbBTC, AERO
- Solana (via Jupiter): SOL, BONK, JUP, WIF

Token aliases (normalize these):
- "Bitcoin" or "BTC" or "WBTC" → cbBTC (Coinbase Wrapped BTC on Base)
- "Tether" → USDT
- "Solana" → SOL

Interpretation rules:
- "Buy $X <TOKEN>" => side=BUY, amountUsd=X, tokenInSymbol=USDC, tokenOutSymbol=<TOKEN>
- "Buy X <TOKEN>" (no $) => side=BUY, amountToken=X, tokenInSymbol=USDC, tokenOutSymbol=<TOKEN>
- "Sell Y <TOKEN>" => side=SELL, amountToken=Y, tokenInSymbol=<TOKEN>, tokenOutSymbol=USDC
- "Swap X <FROM> to <TO>" => side=SWAP, amountToken=X, tokenInSymbol=<FROM>, tokenOutSymbol=<TO>
- "Swap $X to <TOKEN>" => side=SWAP, amountUsd=X, tokenInSymbol=USDC, tokenOutSymbol=<TOKEN>
- When user says "ETH" in a swap context, use WETH as the token symbol

Schema:
{
  "side": "BUY" | "SELL" | "SWAP",
  "amountUsd": number (optional — for dollar amounts),
  "amountToken": number (optional — for token amounts),
  "tokenInSymbol": string,
  "tokenOutSymbol": string,
  "slippageBps": number (0-1000, default 50),
  "chainId": ${chainId}
}`;

  console.log('[API Parse] Using chain ID:', chainId);

  try {
    console.log('[API Parse] Sending request to Claude...');
    const startTime = Date.now();

    const message = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Parse this command: "${command}"` },
      ],
    });

    const elapsed = Date.now() - startTime;
    console.log('[API Parse] ✅ Received response from Claude (took', elapsed, 'ms)');

    const content = message.content[0]?.type === 'text' ? message.content[0].text : null;
    if (!content) {
      console.error('[API Parse] ❌ No content in Claude response');
      return null;
    }

    console.log('[API Parse] Raw response content (first 200 chars):', content.substring(0, 200));

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
      console.log('[API Parse] ✅ Successfully parsed JSON');
    } catch (parseError) {
      console.error('[API Parse] ❌ Failed to parse JSON from response');
      console.error('[API Parse] Content that failed to parse:', content);
      return null;
    }

    console.log('[API Parse] Validating against schema...');
    const result = TradeIntentSchema.safeParse(parsed);

    if (result.success) {
      console.log('[API Parse] ✅ Successfully parsed with LLM:', result.data);
      return result.data;
    }

    console.warn('[API Parse] ⚠️ LLM response did not match schema');
    console.warn('[API Parse] Validation errors:', result.error.issues);
    return null;
  } catch (error) {
    console.error('[API Parse] ❌ Error during LLM parsing');
    console.error('[API Parse] Error:', error);
    return null;
  }
}

// All supported token symbols for regex matching
const TOKEN_PATTERN = '(?:eth|weth|usdc|dai|usdt|tether|btc|bitcoin|cbbtc|aero|sol|solana|bonk|jup|wif)';

/**
 * Fallback deterministic parser for common patterns
 */
function parseWithFallback(command: string): TradeIntent | null {
  console.log('[API Parse] Using regex-based fallback parser for:', command);
  const normalized = command.trim().toLowerCase();

  // Pattern: "Buy $X <TOKEN>" (dollar amount)
  const buyUsdMatch = normalized.match(new RegExp(`buy\\s+\\$([\\.\\d]+)\\s+${TOKEN_PATTERN}`));
  if (buyUsdMatch) {
    const amount = parseFloat(buyUsdMatch[1]);
    const tokenOut = normalizeTokenSymbol(normalized.match(new RegExp(`buy\\s+\\$[\\.\\d]+\\s+(${TOKEN_PATTERN})`))?.[1] || '');
    if (!isNaN(amount) && amount > 0 && tokenOut) {
      return {
        side: 'BUY',
        amountUsd: amount,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
    }
  }

  // Pattern: "Buy X <TOKEN>" (token amount, no $)
  const buyTokenMatch = normalized.match(new RegExp(`buy\\s+([\\.\\d]+)\\s+(${TOKEN_PATTERN})`));
  if (buyTokenMatch) {
    const amount = parseFloat(buyTokenMatch[1]);
    const tokenOut = normalizeTokenSymbol(buyTokenMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      return {
        side: 'BUY',
        amountToken: amount,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
    }
  }

  // Pattern: "Sell $X <TOKEN>" (dollar amount)
  const sellUsdMatch = normalized.match(new RegExp(`sell\\s+\\$([\\.\\d]+)\\s+(?:worth\\s+of\\s+)?(?:of\\s+)?(${TOKEN_PATTERN})`));
  if (sellUsdMatch) {
    const amount = parseFloat(sellUsdMatch[1]);
    const tokenIn = normalizeTokenSymbol(sellUsdMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      return {
        side: 'SELL',
        amountUsd: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: 'USDC',
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
    }
  }

  // Pattern: "Sell X <TOKEN>" (token amount, no $)
  const sellMatch = normalized.match(new RegExp(`sell\\s+([\\.\\d]+)\\s+(${TOKEN_PATTERN})`));
  if (sellMatch) {
    const amount = parseFloat(sellMatch[1]);
    const tokenIn = normalizeTokenSymbol(sellMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      return {
        side: 'SELL',
        amountToken: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: 'USDC',
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
    }
  }

  // Pattern: "Swap X <FROM> to/for <TO>"
  const swapMatch = normalized.match(new RegExp(`swap\\s+([\\.\\d]+)\\s+(${TOKEN_PATTERN})\\s+(?:to|for)\\s+(${TOKEN_PATTERN})`));
  if (swapMatch) {
    const amount = parseFloat(swapMatch[1]);
    const tokenIn = normalizeTokenSymbol(swapMatch[2]);
    const tokenOut = normalizeTokenSymbol(swapMatch[3]);
    if (!isNaN(amount) && amount > 0 && tokenIn !== tokenOut) {
      return {
        side: 'SWAP',
        amountToken: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
    }
  }

  // Pattern: "Swap $X to <TOKEN>" (dollar amount)
  const swapUsdMatch = normalized.match(new RegExp(`swap\\s+\\$([\\.\\d]+)\\s+(?:to|for)\\s+(${TOKEN_PATTERN})`));
  if (swapUsdMatch) {
    const amount = parseFloat(swapUsdMatch[1]);
    const tokenOut = normalizeTokenSymbol(swapUsdMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      return {
        side: 'SWAP',
        amountUsd: amount,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { command } = body;

    if (!command || typeof command !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "command" field' },
        { status: 400 }
      );
    }

    console.log('[API Parse] Starting parse for command:', command);

    // Try LLM first
    const llmResult = await parseWithLLM(command);
    if (llmResult) {
      console.log('[API Parse] ✅ SUCCESS: Using LLM result');
      return NextResponse.json({ intent: llmResult });
    }

    // Fallback to deterministic parser
    console.log('[API Parse] LLM parsing failed, using fallback parser');
    const fallbackResult = parseWithFallback(command);
    if (fallbackResult) {
      console.log('[API Parse] ✅ SUCCESS: Using fallback parser result');
      return NextResponse.json({ intent: fallbackResult });
    }

    console.error('[API Parse] ❌ FAILED: Both parsers failed for command:', command);
    return NextResponse.json(
      {
        intent: null,
        error: 'Could not parse command',
      },
      { status: 400 }
    );
  } catch (error) {
    console.error('[API Parse] Unexpected error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
