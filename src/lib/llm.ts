/**
 * LLM Parser for Natural Language Trading Commands
 * 
 * Two modes:
 * 1. LLM mode: Uses OpenAI to parse natural language
 * 2. Fallback mode: Deterministic regex-based parser for common patterns
 */

import Anthropic from '@anthropic-ai/sdk';
import { TradeIntent, TradeIntentSchema, PredictionIntent, PredictionIntentSchema } from './types';
import { normalizeTokenSymbol, BASE_CHAIN_ID } from './tokens';
import { getChainId } from './rpc';
import { buildMarketsContextForLLM } from './polymarket';

// Lazy-load Claude client
let claudeClient: Anthropic | null = null;

function getClaudeClient(): Anthropic | null {
  console.log('[LLM Parser] Checking for Anthropic API key...');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log('[LLM Parser] ❌ ANTHROPIC_API_KEY not found in process.env');
    console.log('[LLM Parser] Environment check:');
    console.log('[LLM Parser]   - typeof window:', typeof window);
    console.log('[LLM Parser]   - process.env keys containing "ANTHROPIC":',
      Object.keys(process.env).filter(k => k.includes('ANTHROPIC')));
    return null;
  }

  console.log('[LLM Parser] ✅ ANTHROPIC_API_KEY found (length:', apiKey.length, 'chars)');
  console.log('[LLM Parser] Key preview:', apiKey.substring(0, 7) + '...' + apiKey.substring(apiKey.length - 4));

  if (!claudeClient) {
    console.log('[LLM Parser] Initializing Claude client...');
    try {
      claudeClient = new Anthropic({
        apiKey: apiKey,
      });
      console.log('[LLM Parser] ✅ Claude client initialized');
    } catch (initError) {
      console.error('[LLM Parser] ❌ Failed to initialize Claude client:', initError);
      return null;
    }
  } else {
    console.log('[LLM Parser] Using existing Claude client instance');
  }

  return claudeClient;
}

/**
 * Parse natural language command using LLM
 */
async function parseWithLLM(command: string): Promise<TradeIntent | null> {
  console.log('[LLM Parser] ===== Starting LLM parse =====');
  console.log('[LLM Parser] Command:', command);

  const claude = getClaudeClient();
  if (!claude) {
    console.log('[LLM Parser] ❌ Claude API key not configured, skipping LLM parsing');
    console.log('[LLM Parser] Check: process.env.ANTHROPIC_API_KEY =', process.env.ANTHROPIC_API_KEY ? 'SET (length: ' + process.env.ANTHROPIC_API_KEY.length + ')' : 'NOT SET');
    return null;
  }

  console.log('[LLM Parser] ✅ Claude client available');
  console.log('[LLM Parser] Attempting to parse command with Claude:', command);

  const chainId = getChainId();
  const systemPrompt = `You are a trading command parser for an AI swap agent on Base chain. Output ONLY valid JSON matching the schema. No prose.

Supported tokens:
- Base chain: ETH, WETH, USDC, DAI, USDT, cbBTC, AERO
- Solana (via Jupiter): SOL, BONK, JUP, WIF

Token aliases (normalize these):
- "Bitcoin" or "BTC" or "WBTC" → cbBTC (Coinbase Wrapped BTC on Base)
- "Tether" → USDT
- "Solana" → SOL

When a trade involves SOL, BONK, JUP, or WIF — those are Solana tokens swapped via Jupiter.
For Solana buys, tokenInSymbol should be USDC and tokenOutSymbol should be the Solana token.

CRITICAL RULES for amounts:
- "$" or "dollar" or "USD" ALWAYS means a USD amount → use amountUsd, NOT amountToken.
- A plain number with a token (e.g. "0.5 ETH", "100 USDC") means a token amount → use amountToken.
- "$1 of ETH" = amountUsd=1, NOT amountToken=1.
- "1 dollar of ETH" = amountUsd=1.
- "1 ETH" (no dollar sign) = amountToken=1.

Interpretation examples:
- "Buy $5 ETH"                   => side=BUY,  amountUsd=5,     tokenInSymbol=USDC, tokenOutSymbol=ETH
- "Buy 0.01 ETH"                 => side=BUY,  amountToken=0.01,tokenInSymbol=USDC, tokenOutSymbol=ETH
- "Buy $50 of Bitcoin"           => side=BUY,  amountUsd=50,    tokenInSymbol=USDC, tokenOutSymbol=cbBTC
- "Buy $10 AERO"                 => side=BUY,  amountUsd=10,    tokenInSymbol=USDC, tokenOutSymbol=AERO
- "Buy $0.10 SOL"                => side=BUY,  amountUsd=0.10,  tokenInSymbol=USDC, tokenOutSymbol=SOL
- "Buy 2 SOL"                    => side=BUY,  amountToken=2,   tokenInSymbol=USDC, tokenOutSymbol=SOL
- "Swap 10 USDC to BONK"         => side=SWAP, amountToken=10,  tokenInSymbol=USDC, tokenOutSymbol=BONK
- "Sell $10 of ETH"              => side=SELL, amountUsd=10,    tokenInSymbol=ETH,  tokenOutSymbol=USDC
- "Sell 0.5 ETH"                 => side=SELL, amountToken=0.5, tokenInSymbol=ETH,  tokenOutSymbol=USDC
- "Swap $1 of ETH to USDC"       => side=SWAP, amountUsd=1,    tokenInSymbol=ETH,  tokenOutSymbol=USDC
- "Swap 100 DAI to ETH"          => side=SWAP, amountToken=100, tokenInSymbol=DAI,  tokenOutSymbol=ETH
- "Swap 50 USDC to AERO"         => side=SWAP, amountToken=50,  tokenInSymbol=USDC, tokenOutSymbol=AERO

SEND / TRANSFER commands:
- "Send 0.1 ETH to 0xABC..."    => side=SEND, amountToken=0.1, tokenInSymbol=ETH, recipientAddress="0xABC..."
- "Send $5 SOL to ABC123..."     => side=SEND, amountUsd=5,     tokenInSymbol=SOL, recipientAddress="ABC123..."
- "Transfer 100 USDC to 0x..."   => side=SEND, amountToken=100, tokenInSymbol=USDC, recipientAddress="0x..."
- For SEND, tokenOutSymbol should be same as tokenInSymbol
- recipientAddress is REQUIRED for SEND — extract the wallet address from the command
- Addresses starting with 0x are EVM, other base58 strings are Solana

Other rules:
- Keep ETH as ETH (don't convert to WETH)
- Always set chainId to ${chainId} (Base)
- Default slippageBps is 50 (0.5%)
- When user says "swap A to B", tokenInSymbol=A, tokenOutSymbol=B

Schema:
{
  "side": "BUY" | "SELL" | "SWAP" | "SEND",
  "amountUsd": number (optional — ONLY for dollar/USD amounts),
  "amountToken": number (optional — ONLY for raw token amounts),
  "tokenInSymbol": string,
  "tokenOutSymbol": string,
  "recipientAddress": string (optional — REQUIRED for SEND),
  "slippageBps": number (0-1000, default 50),
  "chainId": ${chainId}
}`;

  console.log('[LLM Parser] Using chain ID:', chainId);
  console.log('[LLM Parser] System prompt length:', systemPrompt.length, 'chars');

  try {
    console.log('[LLM Parser] Sending request to Claude...');
    const startTime = Date.now();

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Parse this command: "${command}"` },
      ],
      temperature: 0.1,
    });

    const elapsed = Date.now() - startTime;
    console.log('[LLM Parser] ✅ Received response from Claude (took', elapsed, 'ms)');
    console.log('[LLM Parser] Response content blocks:', response.content?.length || 0);
    console.log('[LLM Parser] Usage:', response.usage ? {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    } : 'N/A');

    const content = response.content[0]?.type === 'text' ? response.content[0].text : null;
    if (!content) {
      console.error('[LLM Parser] ❌ No content in Claude response');
      console.error('[LLM Parser] Full response:', JSON.stringify(response, null, 2));
      return null;
    }

    console.log('[LLM Parser] Raw response content (first 200 chars):', content.substring(0, 200));
    console.log('[LLM Parser] Full response length:', content.length, 'chars');

    // Claude sometimes wraps JSON in ```json ... ``` fences despite instructions.
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
      console.log('[LLM Parser] ✅ Successfully parsed JSON');
      console.log('[LLM Parser] Parsed object keys:', Object.keys(parsed as object));
    } catch (parseError) {
      console.error('[LLM Parser] ❌ Failed to parse JSON from response');
      console.error('[LLM Parser] Parse error:', parseError);
      console.error('[LLM Parser] Content that failed to parse:', content);
      return null;
    }

    console.log('[LLM Parser] Validating against schema...');
    const result = TradeIntentSchema.safeParse(parsed);

    if (result.success) {
      console.log('[LLM Parser] ✅ Successfully parsed with LLM:', result.data);
      console.log('[LLM Parser] ===== LLM parse successful =====');
      return result.data;
    }

    console.warn('[LLM Parser] ⚠️ LLM response did not match schema');
    console.warn('[LLM Parser] Validation errors:', result.error.issues);
    console.warn('[LLM Parser] Received object:', JSON.stringify(parsed, null, 2));
    console.warn('[LLM Parser] Expected schema:', {
      side: 'BUY | SELL | SWAP',
      amountUsd: 'number (optional)',
      amountToken: 'number (optional)',
      tokenInSymbol: 'string',
      tokenOutSymbol: 'string',
      slippageBps: 'number (0-1000)',
      chainId: chainId,
    });
    console.log('[LLM Parser] ===== LLM parse failed (schema mismatch) =====');
    return null;
  } catch (error) {
    console.error('[LLM Parser] ❌ Error during LLM parsing');
    console.error('[LLM Parser] Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('[LLM Parser] Error message:', error instanceof Error ? error.message : String(error));

    if (error instanceof Error) {
      console.error('[LLM Parser] Error stack:', error.stack);

      // Check for specific Claude API errors
      if ('status' in error) {
        console.error('[LLM Parser] HTTP status:', (error as any).status);
      }
      if ('error' in error) {
        console.error('[LLM Parser] Error details:', (error as any).error);
      }
    }

    console.error('[LLM Parser] Full error object:', error);
    console.log('[LLM Parser] ===== LLM parse failed (exception) =====');
    return null;
  }
}

// All supported token symbols for regex matching
const TOKEN_RE = '(?:eth|weth|usdc|dai|usdt|tether|btc|bitcoin|cbbtc|aero|sol|solana|bonk|jup|wif)';

/**
 * Fallback deterministic parser for common patterns
 */
function parseWithFallback(command: string): TradeIntent | null {
  console.log('[Fallback Parser] Using regex-based fallback parser for:', command);
  const normalized = command.trim().toLowerCase();

  // Pattern: "Buy $X <TOKEN>" (dollar amount)
  const buyUsdMatch = normalized.match(new RegExp(`buy\\s+\\$([\\d.]+)\\s+(?:worth\\s+of\\s+)?(?:of\\s+)?(${TOKEN_RE})`));
  if (buyUsdMatch) {
    const amount = parseFloat(buyUsdMatch[1]);
    const tokenOut = normalizeTokenSymbol(buyUsdMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      const result = {
        side: 'BUY' as const,
        amountUsd: amount,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched BUY ($) pattern:', result);
      return result;
    }
  }

  // Pattern: "Buy X <TOKEN>" (token amount, no $)
  const buyTokenMatch = normalized.match(new RegExp(`buy\\s+([\\d.]+)\\s+(${TOKEN_RE})`));
  if (buyTokenMatch) {
    const amount = parseFloat(buyTokenMatch[1]);
    const tokenOut = normalizeTokenSymbol(buyTokenMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      const result = {
        side: 'BUY' as const,
        amountToken: amount,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched BUY (token) pattern:', result);
      return result;
    }
  }

  // Pattern: "Sell $X <TOKEN>" (dollar amount)
  const sellUsdMatch = normalized.match(new RegExp(`sell\\s+\\$([\\d.]+)\\s+(?:worth\\s+of\\s+)?(?:of\\s+)?(${TOKEN_RE})`));
  if (sellUsdMatch) {
    const amount = parseFloat(sellUsdMatch[1]);
    const tokenIn = normalizeTokenSymbol(sellUsdMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      const result = {
        side: 'SELL' as const,
        amountUsd: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: 'USDC',
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched SELL ($) pattern:', result);
      return result;
    }
  }

  // Pattern: "Sell X <TOKEN>" (token amount, no $)
  const sellMatch = normalized.match(new RegExp(`sell\\s+([\\d.]+)\\s+(${TOKEN_RE})`));
  if (sellMatch) {
    const amount = parseFloat(sellMatch[1]);
    const tokenIn = normalizeTokenSymbol(sellMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      const result = {
        side: 'SELL' as const,
        amountToken: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: 'USDC',
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched SELL (token) pattern:', result);
      return result;
    }
  }

  // Pattern: "Swap $X of <TOKEN> to <TOKEN>"
  const swapUsdOfMatch = normalized.match(new RegExp(`swap\\s+\\$([\\d.]+)\\s+(?:dollars?\\s+)?(?:of\\s+)?(${TOKEN_RE})\\s+(?:to|for)\\s+(${TOKEN_RE})`));
  if (swapUsdOfMatch) {
    const amount = parseFloat(swapUsdOfMatch[1]);
    const tokenIn = normalizeTokenSymbol(swapUsdOfMatch[2]);
    const tokenOut = normalizeTokenSymbol(swapUsdOfMatch[3]);
    if (!isNaN(amount) && amount > 0 && tokenIn !== tokenOut) {
      const result = {
        side: 'SWAP' as const,
        amountUsd: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched SWAP ($of) pattern:', result);
      return result;
    }
  }

  // Pattern: "Swap X <TOKEN> to <TOKEN>" (token amount, no $)
  const swapMatch = normalized.match(new RegExp(`swap\\s+([\\d.]+)\\s+(${TOKEN_RE})\\s+(?:to|for)\\s+(${TOKEN_RE})`));
  if (swapMatch) {
    const amount = parseFloat(swapMatch[1]);
    const tokenIn = normalizeTokenSymbol(swapMatch[2]);
    const tokenOut = normalizeTokenSymbol(swapMatch[3]);
    if (!isNaN(amount) && amount > 0 && tokenIn !== tokenOut) {
      const result = {
        side: 'SWAP' as const,
        amountToken: amount,
        tokenInSymbol: tokenIn,
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched SWAP pattern:', result);
      return result;
    }
  }

  // Pattern: "Swap $X to <TOKEN>" (dollar amount, implied USDC in)
  const swapUsdMatch = normalized.match(new RegExp(`swap\\s+\\$([\\d.]+)\\s+(?:to|for)\\s+(${TOKEN_RE})`));
  if (swapUsdMatch) {
    const amount = parseFloat(swapUsdMatch[1]);
    const tokenOut = normalizeTokenSymbol(swapUsdMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      const result = {
        side: 'SWAP' as const,
        amountUsd: amount,
        tokenInSymbol: 'USDC',
        tokenOutSymbol: tokenOut,
        slippageBps: 50,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched SWAP ($→token) pattern:', result);
      return result;
    }
  }

  // Pattern: "Send/Transfer X <TOKEN> to <ADDRESS>"
  const ADDRESS_RE = '(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})'; // EVM or Solana address
  const sendMatch = normalized.match(new RegExp(`(?:send|transfer)\\s+\\$?([\\d.]+)\\s+(${TOKEN_RE})\\s+to\\s+(${ADDRESS_RE})`, 'i'));
  if (sendMatch) {
    const hasDollar = normalized.match(/(?:send|transfer)\s+\$/);
    const amount = parseFloat(sendMatch[1]);
    const token = normalizeTokenSymbol(sendMatch[2]);
    const recipient = sendMatch[3];
    if (!isNaN(amount) && amount > 0 && recipient) {
      const result = {
        side: 'SEND' as const,
        ...(hasDollar ? { amountUsd: amount } : { amountToken: amount }),
        tokenInSymbol: token,
        tokenOutSymbol: token,
        recipientAddress: recipient,
        slippageBps: 0,
        chainId: BASE_CHAIN_ID,
      };
      console.log('[Fallback Parser] ✅ Matched SEND pattern:', result);
      return result;
    }
  }

  console.warn('[Fallback Parser] ❌ No pattern matched for command:', command);
  return null;
}

/**
 * Detect if a command is about prediction markets vs. trading.
 * Simple heuristic — the LLM classifier below is the real authority.
 */
function looksLikePrediction(command: string): boolean {
  const c = command.toLowerCase();
  const keywords = [
    'predict', 'prediction', 'bet ', 'wager', 'will ', 'polymarket',
    'yes on', 'no on', 'buy yes', 'buy no', 'sell yes', 'sell no',
    'odds', 'market for', 'chance', 'probability', 'outcome',
    'who wins', 'will they', 'what are the odds',
  ];
  return keywords.some((kw) => c.includes(kw));
}

/**
 * Parse a prediction market command using the LLM.
 * Injects live Polymarket data as context so the LLM can match
 * user intent to real markets.
 */
export async function parsePredictionIntent(
  command: string,
): Promise<{ intent: PredictionIntent | null; error?: string }> {
  console.log('[Prediction Parser] Starting parse for:', command);

  const claude = getClaudeClient();
  if (!claude) {
    return { intent: null, error: 'Claude API key not configured' };
  }

  // Fetch live market context
  let marketsContext = '';
  try {
    marketsContext = await buildMarketsContextForLLM(15);
  } catch (err) {
    console.warn('[Prediction Parser] Could not fetch market context:', err);
    marketsContext = '(Market data unavailable)';
  }

  const systemPrompt = `You are a prediction market command parser. Output ONLY valid JSON matching the schema. No prose.

You have access to live Polymarket data:

${marketsContext}

Your job: parse the user's natural language command into a structured prediction market intent.

Rules:
- Match the user's intent to one of the active markets above when possible.
- If the user says "bet $X on yes for [topic]" → action=BUY_YES, amountUsd=X
- "bet $X against [topic]" or "bet no on..." → action=BUY_NO
- "sell my yes position on..." → action=SELL_YES
- "what are the odds on..." or "show me [topic]" → action=INFO
- Use the marketQuery field to capture the natural language topic.
- Set the slug field if you can match to one of the markets above.
- If the user doesn't specify an amount and is buying, omit amountUsd.
- If the market data includes tokenIds, set clobTokenIds with the yes and no token IDs.

Schema:
{
  "action": "BUY_YES" | "BUY_NO" | "SELL_YES" | "SELL_NO" | "INFO",
  "marketQuery": string (the topic / question the user is asking about),
  "amountUsd": number (optional — USD amount to bet),
  "slug": string (optional — Polymarket event slug if matched),
  "clobTokenIds": { "yes": string, "no": string } (optional — from market data above)
}`;

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Parse this command: "${command}"` },
      ],
      temperature: 0.1,
    });

    const content = response.content[0]?.type === 'text' ? response.content[0].text : null;
    if (!content) return { intent: null, error: 'No response from LLM' };

    // Claude sometimes wraps JSON in ```json ... ``` fences despite instructions.
    // Strip them before parsing.
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    const result = PredictionIntentSchema.safeParse(parsed);

    if (result.success) {
      console.log('[Prediction Parser] Parsed:', result.data);
      return { intent: result.data };
    }

    console.warn('[Prediction Parser] Schema mismatch:', result.error.issues);
    return { intent: null, error: 'Could not parse prediction market command' };
  } catch (err) {
    console.error('[Prediction Parser] Error:', err);
    return { intent: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Unified parser: classifies whether the command is a trade or prediction,
 * then delegates to the appropriate parser.
 */
export async function parseUnifiedIntent(
  command: string,
): Promise<
  | { type: 'trade'; intent: TradeIntent }
  | { type: 'prediction'; intent: PredictionIntent }
  | { type: 'error'; error: string }
> {
  if (looksLikePrediction(command)) {
    const result = await parsePredictionIntent(command);
    if (result.intent) return { type: 'prediction', intent: result.intent };
    // Fall through to trade parser if prediction parse fails
  }

  const result = await parseTradeIntent(command);
  if (result.intent) return { type: 'trade', intent: result.intent };

  // Last resort: try prediction if trade also failed
  if (!looksLikePrediction(command)) {
    const predResult = await parsePredictionIntent(command);
    if (predResult.intent) return { type: 'prediction', intent: predResult.intent };
  }

  return { type: 'error', error: result.error || 'Could not parse command' };
}

/**
 * Parse natural language command into TradeIntent
 * Tries LLM first, falls back to deterministic parser
 */
export async function parseTradeIntent(command: string): Promise<{ intent: TradeIntent | null; error?: string }> {
  console.log('[Parser] Starting parse for command:', command);

  // Fast path: try the deterministic regex parser first.
  // It handles all common patterns instantly (no network call).
  // Only fall back to the LLM for commands the regex can't handle.
  const fastResult = parseWithFallback(command);
  if (fastResult) {
    console.log('[Parser] ✅ Fast regex match:', JSON.stringify(fastResult));
    return { intent: fastResult };
  }

  // Slow path: LLM for complex / ambiguous commands
  console.log('[Parser] Regex did not match — trying LLM…');
  const llmResult = await parseWithLLM(command);
  if (llmResult) {
    console.log('[Parser] ✅ LLM match:', JSON.stringify(llmResult));
    return { intent: llmResult };
  }

  console.error('[Parser] ❌ Both parsers failed for:', command);
  return {
    intent: null,
    error: 'Could not parse command. Try: "Buy $10 ETH", "Buy $5 SOL", "Sell 0.05 ETH", or "Swap 50 USDC to BONK"',
  };
}
