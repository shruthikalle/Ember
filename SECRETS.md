# Secrets Configuration Guide

**MetaMask + Base Mainnet Setup**

## Required Secrets (Minimum Setup)

```env
# Chain Configuration (REQUIRED)
# Base RPC for Uniswap V4 transactions
NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org
# Or use: https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Token Addresses on Base (REQUIRED)
NEXT_PUBLIC_BASE_WETH_ADDRESS=0x4200000000000000000000000000000000000006
NEXT_PUBLIC_BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

That's it! No OAuth, no MCP server needed.

## Optional Secrets

### For Enhanced Features

```env
# OpenAI (OPTIONAL - for LLM parsing)
# Falls back to regex parser if not provided
OPENAI_API_KEY=sk-...

# Uniswap V4 Contract Addresses on Base (OPTIONAL - defaults provided)
NEXT_PUBLIC_UNISWAP_ROUTER_ADDRESS=0x6ff5693b99212da76ad316178a184ab56d299b43
NEXT_PUBLIC_UNISWAP_QUOTER_ADDRESS=0x0d5e0f971ed27fbff6c2837bf31316121532048d
NEXT_PUBLIC_PERMIT2_ADDRESS=0x000000000022D473030F116dDEE9F6B43aC78BA3
UNISWAP_API_URL=https://api.uniswap.org/v2

# Trading Limits (OPTIONAL - defaults provided)
NEXT_PUBLIC_MAX_TRADE_SIZE_USD=250
NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS=50
NEXT_PUBLIC_MAX_SLIPPAGE_BPS=100

# Hyperliquid Perps — trades signed via MetaMask, no private key needed
# Market data fetched from api.hyperliquid.xyz/info (no key needed).
#
# QuickNode HyperCore (OPTIONAL — for enhanced real-time data)
# If set, all Hyperliquid API calls route through QuickNode HyperCore
# instead of the public API. Provides better reliability and real-time streaming.
# QUICKNODE_HL_ENDPOINT=https://your-endpoint.quicknode.com

# ─── Polymarket Prediction Markets ───────────────────────────────
# Market analysis uses OPENAI_API_KEY (set above) — no extra key needed.

# Polymarket CLOB API credentials (for order placement & balance)
#
# REQUIRED — your MetaMask private key (the EOA that logged into Polymarket):
#   MetaMask → ⋮ → Account Details → Show Private Key
POLY_PRIVATE_KEY=0x...
#
# REQUIRED — your Polymarket PROXY WALLET address (NOT your MetaMask address):
#   Go to polymarket.com → Profile → Settings → look for "Proxy Wallet"
#   or "Deposit Address" — it's a DIFFERENT 0x address from your MetaMask.
#   If you don't have one, leave this blank and signatureType 0 (EOA) is used.
POLY_ADDRESS=0x...
#
# OPTIONAL — manual API credentials (from Polymarket Settings → API Keys)
# If set, these are used instead of auto-deriving from POLY_PRIVATE_KEY.
# POLY_API_KEY=...
# POLY_SECRET=...
# POLY_PASSPHRASE=...

# Polygon RPC (optional — defaults to public RPC)
# POLYGON_RPC_URL=https://polygon-rpc.com
```

## Setup

1. Create `.env` in the project root
2. Set only the **Required** secrets above
3. Run `npm run dev`
4. Connect MetaMask when prompted
5. Start trading!

## How It Works

- **Wallet Connection**: Direct MetaMask connection via `ethers.BrowserProvider`
- **Transaction Signing**: All transactions signed directly in MetaMask
- **Network**: Automatically switches to Base if needed
- **Uniswap V4**: Uses Universal Router + Permit2 for token approvals
- **Hyperliquid Perps**: Trades signed via MetaMask EIP-712 and submitted to Hyperliquid API (no chain switching needed)
- **No Backend Required**: All wallet operations happen client-side
