# x402 Autonomous Swap Agent

A **paid, fully autonomous** LLM-powered Uniswap swap agent with **x402 HTTP 402 payment gating** and **ERC-8021 builder code** attribution on Base.

Judges/users call a public endpoint to execute trades. The agent charges a USDC fee per use, verifies payment on-chain, then builds, signs, and broadcasts the swap transaction — all server-side with an agent-owned EOA.

## Features

- **x402 Payment Gating**: Every request requires a USDC payment on Base before execution
- **Natural Language Trading**: Parse commands like "Buy $5 ETH" or "Sell 0.05 ETH"
- **Autonomous Execution**: Agent-owned EOA signs and broadcasts all transactions (no MetaMask required for API usage)
- **ERC-8021 Builder Codes**: Every on-chain tx appends a Base builder code suffix for attribution
- **Public Dashboard**: Real-time stats showing wallet balances, revenue, costs, and profit
- **Hybrid V3+V4 Uniswap**: Routes through whichever Uniswap protocol version gives best output
- **Mock Mode**: `MOCK_SWAP=true` sends 0-value self-txs for safe end-to-end testing
- **MetaMask Chat UI**: Legacy chat interface at `/chat` for direct MetaMask swaps
- **Safety Guardrails**: Max trade size, token allowlist, slippage limits

## x402 Flow (How a Judge Can Test)

1. **Open the dashboard** at `http://localhost:3000/` (or the deployed URL).
2. **Use the "Try It" widget** — type a command like `Buy $5 ETH` and click **Send**.
3. The agent returns **402 Payment Required** with USDC payment instructions.
4. **Transfer USDC** to the displayed agent address on Base (or Base Sepolia).
5. Copy the **payment tx hash** and paste it into the input field.
6. Click **Verify & Execute**. The agent verifies payment on-chain, builds the swap, appends the ERC-8021 builder code suffix, signs and broadcasts the tx, and returns the result.
7. The dashboard auto-refreshes every 15 seconds to show updated stats.

### API Contract

```
POST /api/execute
Body: { "command": "Buy $5 ETH", "params": { "slippageBps": 50 } }

→ 402 (no payment): { payee_addr, amount, token_type, chain_id, payment_id, expires_at, request_hash }
→ 200 (payment verified): { trade_tx_hash, payment_tx_hash, builder_code, summary, receipt }

Header for retry: X-Payment: base64(JSON.stringify({ payment_id, tx_hash, payee_addr, token_type, amount, chain_id, request_hash }))

GET /api/stats
→ 200: { agent_address, balances, totals, recent_payments, recent_trades }
```

## Architecture

- **Frontend**: Next.js (App Router) + TypeScript
- **Backend**: Next.js API routes (Node runtime)
- **Agent Wallet**: EOA from `AGENT_PRIVATE_KEY` (ethers v6)
- **Database**: SQLite (better-sqlite3) at `data/agent.db`
- **Chain**: Base Sepolia (default, chainId 84532) or Base Mainnet (8453), configurable via `CHAIN_ID`
- **DEX**: Uniswap Hybrid V3+V4 via Universal Router
- **Payments**: x402 — USDC transfer on Base, verified on-chain
- **Builder Codes**: ERC-8021 suffix appended to every tx calldata

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/x402.ts` | Build 402 response, parse X-Payment header |
| `src/lib/paymentVerify.ts` | On-chain USDC transfer verification |
| `src/lib/builderCode.ts` | ERC-8021 suffix append + verify |
| `src/lib/wallet.ts` | Agent EOA signer + balance helpers |
| `src/lib/db.ts` | SQLite schema + typed queries |
| `src/lib/pricing.ts` | Gas + compute cost accounting |
| `src/lib/uniswap/adapter.ts` | RouterAdapter interface |
| `src/lib/uniswap/realAdapter.ts` | Real Uniswap V3+V4 swap builder |
| `src/lib/uniswap/mockAdapter.ts` | Mock self-tx adapter |
| `app/api/execute/route.ts` | x402-gated swap endpoint |
| `app/api/stats/route.ts` | Public stats endpoint |
| `app/page.tsx` | Dashboard + Try It widget |
| `app/chat/page.tsx` | Legacy MetaMask chat UI |

## Prerequisites

- Node.js 18+
- npm

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with at minimum:

```env
# Required — agent wallet private key
AGENT_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Chain: 84532 (Base Sepolia, default) or 8453 (Base Mainnet)
CHAIN_ID=84532

# Base RPC URL (recommended: use premium endpoint to avoid rate limits)
# Public endpoint (rate-limited): https://mainnet.base.org
# Premium options:
# - Alchemy: https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
# - Infura: https://base-mainnet.infura.io/v3/YOUR_KEY
NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org

# Mock mode — set to "true" for safe testing (self-txs instead of real swaps)
MOCK_SWAP=true

# Builder code from base.dev (hex string)
BUILDER_CODE=

# Optional: OpenAI for smarter command parsing
OPENAI_API_KEY=
NEXT_PUBLIC_MAX_SLIPPAGE_BPS=100
```

### 3. Get Ethereum Mainnet Tokens

You'll need tokens on Ethereum Mainnet for Uniswap trading:

- **ETH**: Native token for gas fees
- **WETH**: Wrapped ETH (address: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`)
- **USDC**: USD Coin (address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`)

**Token Addresses:**
- Default addresses are pre-configured for mainnet
- Update `NEXT_PUBLIC_MAINNET_WETH_ADDRESS` and `NEXT_PUBLIC_MAINNET_USDC_ADDRESS` in `.env` if needed
- Find addresses on [Basescan](https://basescan.org)


### 4. Run Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:3000`

## Usage

### 1. Login with Kite Passport

Click "Login with Kite Passport" to authenticate. This connects your wallet via MCP.

**Development Mode:**
- Set `NEXT_PUBLIC_MOCK_MCP=true` to use a mock wallet (DEV ONLY)
- No OAuth required in mock mode

### 2. Execute Trades

Type natural language commands in the chat:

- **Buy**: "Buy $100 ETH"
- **Sell**: "Sell 0.05 ETH"
- **Swap**: "Swap 50 USDC to WETH"

### 3. Review & Confirm

A review modal will show:
- Token pair (from/to)
- Amount in/out
- Minimum amount out (after slippage)
- Slippage percentage
- Chain and recipient address
- Guardrail validation

Click "Confirm & Sign" to proceed.

### 4. Transaction Execution

1. Transaction is built and signed via MetaMask
2. Signed transaction is broadcast to Ethereum Mainnet
3. Transaction hash and explorer link are displayed
4. Receipt is polled and displayed when confirmed

## API Endpoints

### POST /api/quote

Get quote for a trade intent.

**Request:**
```json
{
  "intent": {
    "side": "BUY",
    "amountUsd": 100,
    "tokenInSymbol": "USDC",
    "tokenOutSymbol": "WETH",
    "slippageBps": 50,
    "chainId": 1
  },
  "walletAddress": "0x..."
}
```

**Response:**
```json
{
  "amountIn": "100000000",
  "amountOut": "33333333333333333333",
  "minAmountOut": "33166666666666666666",
  "amountInFormatted": "100.0",
  "amountOutFormatted": "0.0333",
  "minAmountOutFormatted": "0.0331",
  "slippageBps": 50,
  "route": []
}
```

**402 Payment Required:**
If `PAID_MODE=true`, may return 402 with payment info. The `callX402Service` helper handles this automatically.

### POST /api/buildSwap

Build swap transaction ready to sign.

**Request:**
```json
{
  "intent": {...},
  "quote": {...},
  "walletAddress": "0x..."
}
```

**Response:**
```json
{
  "to": "0x...",
  "data": "0x...",
  "value": "0x0",
  "chainId": 1,
  "gas": "150000",
  "deadline": 1234567890
}
```

### POST /api/broadcast

Broadcast signed transaction.

**Request:**
```json
{
  "signedTransaction": "0x..."
}
```

**Response:**
```json
{
  "txHash": "0x...",
  "explorerUrl": "https://basescan.org/tx/0x...",
  "receipt": {...}
}
```

## Transaction Flow

1. User types natural language command
2. LLM parses command into trade intent
3. System gets quote from Uniswap
4. User reviews trade details in modal
5. User confirms and signs transaction in MetaMask
6. Transaction is broadcast to Ethereum Mainnet
7. Receipt is displayed when confirmed

## Safety Guardrails

- **Max Trade Size**: $250 USD (configurable via `NEXT_PUBLIC_MAX_TRADE_SIZE_USD`)
- **Token Allowlist**: USDC and WETH only
- **Slippage Cap**: ≤ 1% (100 bps, configurable via `NEXT_PUBLIC_MAX_SLIPPAGE_BPS`)
- **Deadline**: 10 minutes maximum
- **Chain**: Base Mainnet (8453) for Uniswap transactions

## Wallet Integration

The application uses MetaMask for all wallet operations:

- **Connection**: Direct MetaMask connection via `ethers.BrowserProvider`
- **Signing**: Transactions signed directly in MetaMask
- **Network**: Automatically switches to Ethereum Mainnet if needed
- **Account Changes**: Listens for account/chain changes and updates UI

## Project Structure

```
ethdenver/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   │   ├── quote/         # Quote endpoint
│   │   ├── buildSwap/     # Build swap endpoint
│   │   └── broadcast/     # Broadcast endpoint
│   ├── layout.tsx         # Root layout
│   ├── page.tsx           # Main chat UI
│   └── globals.css        # Global styles
├── src/
│   ├── lib/               # Core libraries
│   │   ├── types.ts       # TypeScript types
│   │   ├── llm.ts         # LLM parser + fallback
│   │   ├── x402.ts        # API call helper (x402 support optional)
│   │   ├── tokens.ts      # Token configuration
│   │   ├── uniswap.ts     # Uniswap integration
│   │   ├── rpc.ts         # RPC provider
│   │   ├── policy.ts      # Guardrails
│   │   └── storage.ts     # Trade history
│   └── components/        # React components
│       ├── ChatInterface.tsx
│       ├── TradeReviewModal.tsx
│       ├── MessageList.tsx
│       └── MetaMaskButton.tsx
├── next.config.js         # Next.js config
├── tsconfig.json          # TypeScript config
├── .env.example           # Environment template
└── README.md              # This file
```

## Troubleshooting

### "MCP client not connected"
- Check `NEXT_PUBLIC_MCP_SERVER_URL` is correct
- Or set `NEXT_PUBLIC_MOCK_MCP=true` for development
- Check browser console for connection errors

### "Token not found"
- Verify token addresses in `.env`
- Check addresses on Basescan
- Ensure tokens exist on Ethereum Mainnet

### "Quote failed"
- Check Uniswap API is accessible
- Verify router address is correct for Ethereum Mainnet
- Check RPC URL is working

### "Transaction failed"
- Ensure wallet has sufficient balance
- Check token approvals (ERC20)
- Verify slippage is acceptable
- Check gas estimation

## TODO / Integration Points

- [ ] Replace placeholder OAuth with real Kite Passport endpoints
- [ ] Update MCP server URL when Kite provides production endpoint
- [ ] Verify Ethereum Mainnet Uniswap router addresses
- [ ] Add real-time price oracles for accurate quotes
- [ ] Implement proper MCP protocol over SSE
- [ ] Add error recovery and retry logic
- [ ] Implement proper session management

## License

MIT

## Resources

- [Uniswap Documentation](https://docs.uniswap.org)
- [Hyperliquid Documentation](https://hyperliquid.gitbook.io/hyperliquid-docs)
- [Next.js Documentation](https://nextjs.org/docs)

## Chain Configuration

**Base Mainnet (for Uniswap swaps)**
- Chain ID: `8453`
- RPC URL: `NEXT_PUBLIC_BASE_RPC_URL` (default: `https://mainnet.base.org`)
- Explorer: `https://basescan.org`
- Native Token: ETH

**Hyperliquid L1 (for perpetual futures)**
- API: `https://api.hyperliquid.xyz`
- 150+ perp markets, up to 50x leverage
- Trades signed via MetaMask (EIP-712), no chain switching required
- Collateral: USDC (deposited from Arbitrum)
