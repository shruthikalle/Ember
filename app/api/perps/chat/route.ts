/**
 * POST /api/perps/chat
 *
 * AI-powered perps trading chat. Accepts natural language,
 * returns structured trade actions or conversational responses.
 *
 * Supports both dollar and token amounts:
 *   "Long $2 of ETH at 10x"  → calculates size from USD
 *   "Long 0.001 ETH at 10x"  → uses token amount directly
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getMarketData, getUserState, buildTradeParams } from '@/src/lib/hyperliquid';

export const dynamic = 'force-dynamic';

/**
 * Tick-align a price string for Hyperliquid. Uses the mark price's existing
 * decimal count (which is always tick-aligned by HL) AND caps to 5 significant
 * figures, which is Hyperliquid's actual combined rule. More reliable than
 * guessing tick size from price magnitude.
 */
function tickAlignPrice(rawPrice: number, markPriceStr: string): string {
  // Extract decimal count from Hyperliquid's canonical mark price
  const dotIdx = markPriceStr.indexOf('.');
  const markDecimals = dotIdx === -1 ? 0 : markPriceStr.length - dotIdx - 1;

  // Cap by sig figs: Hyperliquid allows max 5 sig figs for perp prices
  const magnitude = rawPrice > 0 ? Math.floor(Math.log10(rawPrice)) + 1 : 1;
  const maxBySigFigs = Math.max(0, 5 - magnitude);

  // Use the tighter of the two constraints
  const decimals = Math.min(markDecimals, maxBySigFigs);
  return rawPrice.toFixed(decimals);
}

let claude: Anthropic | null = null;

function getClaude(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!claude) claude = new Anthropic({ apiKey: key });
  return claude;
}

const SYSTEM_PROMPT = `You are a Hyperliquid perps trading assistant. You help users trade perpetual futures.

IMPORTANT: Output ONLY valid JSON. No prose, no markdown, no explanation outside of the JSON.

Supported actions:
1. OPEN TRADE — user wants to long/short a coin
2. CLOSE TRADE — user wants to close a position
3. INFO — user asks about a market, funding, price
4. POSITIONS — user wants to see their positions
5. CHAT — general conversation

For OPEN TRADE, parse these formats:
- "Long $2 of ETH at 10x" → amountUsd=2, coin=ETH, side=LONG, leverage=10
- "Long 0.001 ETH at 10x" → amountToken=0.001, coin=ETH, side=LONG, leverage=10
- "Short BTC 5x $1" → amountUsd=1, coin=BTC, side=SHORT, leverage=5
- "Short 0.0001 BTC at 20x" → amountToken=0.0001, coin=BTC, side=SHORT, leverage=20
- "$" or "dollar" ALWAYS means USD amount → use amountUsd
- A plain number means token amount → use amountToken
- Default leverage is 10x if not specified

For CLOSE TRADE:
- "Close my ETH position" → coin=ETH
- "Close ETH long" → coin=ETH

For INFO:
- "What's the ETH price?" → coin=ETH
- "ETH funding rate" → coin=ETH
- "Show me BTC" → coin=BTC

Output JSON schema:
{
  "action": "open_trade" | "close_trade" | "info" | "positions" | "chat",
  "coin": string (optional — e.g. "ETH", "BTC", "SOL"),
  "side": "LONG" | "SHORT" (only for open_trade),
  "amountUsd": number (optional — dollar amount),
  "amountToken": number (optional — token amount),
  "leverage": number (optional — default 10),
  "orderType": "market" | "limit" (default "market"),
  "limitPrice": number (optional — only for limit orders),
  "message": string (friendly response to show the user)
}`;

export async function POST(req: NextRequest) {
  try {
    const { messages, walletAddress, defaultCoin } = await req.json() as {
      messages: any[];
      walletAddress?: string;
      defaultCoin?: string;
    };

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Missing messages array' }, { status: 400 });
    }

    const client = getClaude();

    // ── Parse intent (LLM or fallback) ──────────────────────────
    let parsed: any;

    if (client) {
      // Inject the chart's currently selected coin as the default — if the
      // user types "Long $3" with no coin, Claude should assume the chart
      // selection rather than asking for clarification.
      const systemWithContext = defaultCoin
        ? `${SYSTEM_PROMPT}\n\nCURRENT CHART CONTEXT:\nThe user is currently viewing the ${defaultCoin.toUpperCase()} chart. If the user mentions a trade action (long/short/close/info) without specifying a coin, default to "${defaultCoin.toUpperCase()}". Examples:\n- "Long $5 5x" (chart=${defaultCoin.toUpperCase()}) → coin="${defaultCoin.toUpperCase()}", side="LONG", amountUsd=5, leverage=5\n- "close position" (chart=${defaultCoin.toUpperCase()}) → action="close_trade", coin="${defaultCoin.toUpperCase()}"\nOnly ask for clarification if the user's intent is genuinely ambiguous (not just a missing coin).`
        : SYSTEM_PROMPT;

      const resp = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemWithContext,
        messages: messages.slice(-10).map((m: any) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        })),
        temperature: 0.1,
      });

      const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
      // Claude sometimes wraps JSON in ```json ... ``` fences despite instructions.
      // Strip them before parsing so real trade actions aren't treated as chat.
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // If JSON parse still fails, treat as chat
        parsed = { action: 'chat', message: text };
      }
    } else {
      // Fallback regex parsing
      parsed = fallbackParse(messages[messages.length - 1]?.content || '');
    }

    // Fall back to the chart's currently selected coin when the user didn't
    // specify one (e.g. they typed "Long $3" while looking at the LINK chart).
    if (defaultCoin && !parsed.coin && (parsed.action === 'open_trade' || parsed.action === 'close_trade' || parsed.action === 'info')) {
      parsed.coin = defaultCoin.toUpperCase();
    }

    // ── Handle action ───────────────────────────────────────────

    // INFO: fetch market data
    if (parsed.action === 'info' && parsed.coin) {
      try {
        const data = await getMarketData(parsed.coin);
        const fundingAnnual = (parseFloat(data.fundingRate) * 24 * 365 * 100).toFixed(2);
        return NextResponse.json({
          content: `**${data.coin}** — $${parseFloat(data.markPrice).toLocaleString()}\n\nFunding: ${(parseFloat(data.fundingRate) * 100).toFixed(4)}% (${fundingAnnual}% annualized)\nOpen Interest: $${(parseFloat(data.openInterest) * parseFloat(data.markPrice)).toLocaleString(undefined, { maximumFractionDigits: 0 })}\n24h Volume: $${parseFloat(data.volume24h).toLocaleString(undefined, { maximumFractionDigits: 0 })}\nMax Leverage: ${data.maxLeverage}x\n24h Change: ${data.priceChange24hPct}%`,
        });
      } catch (err) {
        return NextResponse.json({
          content: `Could not fetch data for ${parsed.coin}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // POSITIONS: fetch user state
    if (parsed.action === 'positions') {
      if (!walletAddress) {
        return NextResponse.json({
          content: 'Connect your wallet first to view positions.',
        });
      }
      try {
        const state = await getUserState(walletAddress);
        const positions = state?.assetPositions?.filter(
          (p: any) => parseFloat(p.position?.szi || '0') !== 0,
        );

        if (!positions || positions.length === 0) {
          return NextResponse.json({
            content: `No open positions. Account value: $${parseFloat(state?.marginSummary?.accountValue || '0').toFixed(2)}`,
          });
        }

        const lines = positions.map((p: any) => {
          const pos = p.position;
          const size = parseFloat(pos.szi);
          const entry = parseFloat(pos.entryPx);
          const unrealizedPnl = parseFloat(pos.unrealizedPnl || '0');
          const side = size > 0 ? 'LONG' : 'SHORT';
          return `${pos.coin} ${side} ${Math.abs(size)} @ $${entry.toFixed(2)} | PnL: $${unrealizedPnl.toFixed(2)}`;
        });

        return NextResponse.json({
          content: `**Open Positions:**\n\n${lines.join('\n')}\n\nAccount Value: $${parseFloat(state?.marginSummary?.accountValue || '0').toFixed(2)}`,
        });
      } catch (err) {
        return NextResponse.json({
          content: `Error fetching positions: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // OPEN TRADE: build trade params
    if (parsed.action === 'open_trade' && parsed.coin) {
      try {
        const market = await getMarketData(parsed.coin);
        const markPrice = parseFloat(market.markPrice);
        const leverage = parsed.leverage || 10;
        const side = parsed.side || 'LONG';

        // Ember interprets the `$X` in commands as the user's MARGIN
        // (the money they're putting up), not the notional position size.
        // This is way more intuitive for non-pro traders. We compute notional
        // by multiplying margin × leverage, then bump to Hyperliquid's $10
        // minimum if needed.
        const HL_MIN_NOTIONAL = 10;
        let margin: number;
        let sizeUsd: number; // notional position size
        let notionalBumped = false;
        let tokenSize: number;

        if (parsed.amountToken) {
          // Token-denominated trade: user said e.g. "0.001 ETH"
          tokenSize = parsed.amountToken;
          sizeUsd = tokenSize * markPrice;
          margin = sizeUsd / leverage;
        } else if (parsed.amountUsd) {
          // Dollar amount = margin (user's money at risk)
          margin = parsed.amountUsd;
          sizeUsd = margin * leverage;

          // Bump to $10 minimum if needed
          if (sizeUsd < HL_MIN_NOTIONAL) {
            sizeUsd = HL_MIN_NOTIONAL;
            margin = sizeUsd / leverage;
            notionalBumped = true;
          }
          tokenSize = sizeUsd / markPrice;
        } else {
          return NextResponse.json({
            content: 'Please specify an amount. Example: "Long $2 ETH 5x" (= $2 margin, $10 position) or "Long 0.001 ETH 5x"',
          });
        }

        // Round token size down to szDecimals
        const factor = Math.pow(10, market.szDecimals);
        tokenSize = Math.floor(tokenSize * factor) / factor;

        if (tokenSize <= 0) {
          return NextResponse.json({
            content: `Amount too small. Minimum size for ${market.coin} is ${(1 / factor).toFixed(market.szDecimals)} ${market.coin} (~$${(markPrice / factor).toFixed(2)}).`,
          });
        }

        // Recompute notional from rounded size so it matches what we actually send
        sizeUsd = tokenSize * markPrice;
        // (margin is what we display; keep based on user's intent / leverage)
        if (!parsed.amountToken && !notionalBumped) {
          margin = parsed.amountUsd!;
        } else {
          margin = sizeUsd / leverage;
        }

        // Approximate liquidation price (ignores maintenance margin ratio)
        const liqDelta = markPrice / leverage;
        const liqPrice = side === 'LONG' ? markPrice - liqDelta : markPrice + liqDelta;

        // Hyperliquid simulates market orders with IOC limit orders. To
        // guarantee a fill, the limit price must cross the spread —
        // mark price alone is mid-book and will be cancelled with
        // "could not immediately match". Add 2% slippage cushion and match
        // the mark price's existing decimal precision (which Hyperliquid
        // already tick-aligns for us).
        const slipBps = 200; // 2%
        const slipMultiplier = side === 'LONG' ? 1 + slipBps / 10_000 : 1 - slipBps / 10_000;
        const limitPriceRaw = markPrice * slipMultiplier;
        const orderPrice = tickAlignPrice(limitPriceRaw, market.markPrice);

        const tradeParams = {
          assetIndex: market.assetIndex,
          coin: market.coin,
          side,
          size: tokenSize.toFixed(market.szDecimals),
          price: orderPrice,
          leverage,
          szDecimals: market.szDecimals,
          reduceOnly: false,
          orderType: parsed.orderType || 'market',
          tickSize: market.tickSize,
        };

        const bumpNote = notionalBumped
          ? `\n\n⚠️ Bumped position to $${HL_MIN_NOTIONAL} (Hyperliquid minimum). Your margin is now ~$${margin.toFixed(2)}.`
          : '';

        return NextResponse.json({
          content:
            `**${side} ${market.coin}** ${leverage}x\n\n` +
            `• Margin (your money): **$${margin.toFixed(2)}**\n` +
            `• Position size: **$${sizeUsd.toFixed(2)}** (${tokenSize.toFixed(market.szDecimals)} ${market.coin})\n` +
            `• Entry: ~$${markPrice.toLocaleString()}\n` +
            `• Liquidation: ~$${liqPrice.toFixed(2)} (${((Math.abs(liqPrice - markPrice) / markPrice) * 100).toFixed(1)}% ${side === 'LONG' ? 'down' : 'up'})\n` +
            `• Order: Market` +
            bumpNote +
            `\n\n⚡ Review and confirm in the modal.`,
          action: {
            type: 'open_trade',
            tradeParams,
            marketData: {
              markPrice: market.markPrice,
              fundingRate: market.fundingRate,
              maxLeverage: market.maxLeverage,
            },
            sizeUsd,
          },
        });
      } catch (err) {
        return NextResponse.json({
          content: `Error building trade: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // CLOSE TRADE
    if (parsed.action === 'close_trade' && parsed.coin) {
      if (!walletAddress) {
        return NextResponse.json({ content: 'Connect your wallet to close positions.' });
      }
      try {
        const state = await getUserState(walletAddress);
        const position = state?.assetPositions?.find(
          (p: any) => p.position?.coin?.toUpperCase() === parsed.coin.toUpperCase() && parseFloat(p.position?.szi || '0') !== 0,
        );

        if (!position) {
          return NextResponse.json({ content: `No open ${parsed.coin} position found.` });
        }

        const pos = position.position;
        const size = parseFloat(pos.szi);
        const market = await getMarketData(parsed.coin);

        // Same IOC slippage padding as open: closing a long is a sell
        // (needs price below mark), closing a short is a buy (needs above).
        // Match the mark price's existing decimal precision for tick alignment.
        const isBuyToClose = size < 0;
        const closeMark = parseFloat(market.markPrice);
        const closeSlipMult = isBuyToClose ? 1.02 : 0.98;
        const closeRaw = closeMark * closeSlipMult;
        const closeOrderPrice = tickAlignPrice(closeRaw, market.markPrice);

        const closeParams = {
          assetIndex: market.assetIndex,
          coin: market.coin,
          size: Math.abs(size).toFixed(market.szDecimals),
          price: closeOrderPrice,
          isBuy: isBuyToClose,
          szDecimals: market.szDecimals,
        };

        return NextResponse.json({
          content: `**Close ${market.coin} ${size > 0 ? 'LONG' : 'SHORT'}** — ${Math.abs(size)} ${market.coin}\nEntry: $${parseFloat(pos.entryPx).toFixed(2)} → Current: $${parseFloat(market.markPrice).toLocaleString()}\nPnL: $${parseFloat(pos.unrealizedPnl || '0').toFixed(2)}`,
          action: { type: 'close_trade', closeParams },
        });
      } catch (err) {
        return NextResponse.json({
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // CHAT: general response
    return NextResponse.json({
      content: parsed.message || "I can help you trade perps. Try: \"Long $2 of ETH at 10x\" or \"What's the BTC price?\"",
    });
  } catch (err) {
    console.error('[Perps Chat]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}

// ─── Fallback regex parser (no LLM needed) ─────────────────────────────────

function fallbackParse(input: string): any {
  const n = input.trim().toLowerCase();

  // Long/Short with $ amount
  const dollarMatch = n.match(/(long|short)\s+\$([.\d]+)\s+(?:of\s+)?(\w+)(?:\s+(?:at\s+)?(\d+)x)?/);
  if (dollarMatch) {
    return {
      action: 'open_trade',
      side: dollarMatch[1].toUpperCase(),
      amountUsd: parseFloat(dollarMatch[2]),
      coin: dollarMatch[3].toUpperCase(),
      leverage: dollarMatch[4] ? parseInt(dollarMatch[4]) : 10,
      message: '',
    };
  }

  // Long/Short with token amount
  const tokenMatch = n.match(/(long|short)\s+([.\d]+)\s+(\w+)(?:\s+(?:at\s+)?(\d+)x)?/);
  if (tokenMatch) {
    return {
      action: 'open_trade',
      side: tokenMatch[1].toUpperCase(),
      amountToken: parseFloat(tokenMatch[2]),
      coin: tokenMatch[3].toUpperCase(),
      leverage: tokenMatch[4] ? parseInt(tokenMatch[4]) : 10,
      message: '',
    };
  }

  // Long/Short with $ at end: "Long ETH 10x $2"
  const endDollarMatch = n.match(/(long|short)\s+(\w+)\s+(\d+)x\s+\$([.\d]+)/);
  if (endDollarMatch) {
    return {
      action: 'open_trade',
      side: endDollarMatch[1].toUpperCase(),
      coin: endDollarMatch[2].toUpperCase(),
      leverage: parseInt(endDollarMatch[3]),
      amountUsd: parseFloat(endDollarMatch[4]),
      message: '',
    };
  }

  // Close position
  const closeMatch = n.match(/close\s+(?:my\s+)?(\w+)/);
  if (closeMatch) {
    return { action: 'close_trade', coin: closeMatch[1].toUpperCase(), message: '' };
  }

  // Price / info query
  const infoMatch = n.match(/(?:price|funding|show|what(?:'s| is))\s+(?:the\s+)?(?:of\s+)?(\w+)/);
  if (infoMatch) {
    return { action: 'info', coin: infoMatch[1].toUpperCase(), message: '' };
  }

  // Positions
  if (n.includes('position') || n.includes('portfolio') || n.includes('balance')) {
    return { action: 'positions', message: '' };
  }

  return { action: 'chat', message: "Try: \"Long $2 of ETH at 10x\", \"Short BTC 5x\", or \"What's the ETH price?\"" };
}
