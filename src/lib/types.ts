import { z } from 'zod';

/**
 * Trade Intent Schema
 * Validated structure for trading commands
 */
export const TradeIntentSchema = z.object({
  side: z.enum(['BUY', 'SELL', 'SWAP', 'SEND']),
  amountUsd: z.number().positive().optional(),
  amountToken: z.number().positive().optional(),
  tokenInSymbol: z.string().min(1),
  tokenOutSymbol: z.string().min(1).default('USDC'),  // default for SEND (unused but schema requires it)
  recipientAddress: z.string().optional(),              // wallet address for SEND
  slippageBps: z.number().int().min(0).max(1000).default(50),
  chainId: z.number().int().default(parseInt(process.env.CHAIN_ID || process.env.NEXT_PUBLIC_CHAIN_ID || '8453', 10)),
});

export type TradeIntent = z.infer<typeof TradeIntentSchema>;

/**
 * Quote Response
 * Contains swap quote information from Uniswap
 */
export interface Quote {
  amountIn: string; // Raw amount (wei/smallest unit)
  amountOut: string; // Raw amount out
  minAmountOut: string; // Minimum amount out after slippage
  amountInFormatted: string; // Human-readable
  amountOutFormatted: string; // Human-readable
  minAmountOutFormatted: string; // Human-readable
  slippageBps: number;
  route: unknown[]; // Uniswap route information
  gasEstimate?: string;
  priceImpact?: string;
  // Pool metadata (passed from getQuote → buildSwapTransaction)
  poolFee?: number;         // e.g. 500, 3000, 10000
  poolTickSpacing?: number; // e.g. 10, 60, 200  (V4 only)
  swapVersion?: 'v3' | 'v4' | 'api'; // Which protocol / source — 'api' = Uniswap Routing API
  // Pre-built calldata from the Uniswap API (present when swapVersion === 'api')
  apiCalldata?: string;
  apiValue?: string;        // hex tx value from the API
}

/**
 * Build Swap Transaction Request
 * Transaction ready to be signed
 */
export interface ApprovalTx {
  to: string; // Token or Permit2 address
  data: string; // Approval calldata
  value: string; // Always "0x0"
  chainId: number;
  label: string; // Human-readable label (e.g. "Approve USDC for Permit2")
  tokenSymbol: string; // Token symbol for display
  tokenAddress: string; // Token address
  spender: string; // Spender address
  amount: string; // Approval amount (formatted)
}

export interface BuildSwapTx {
  to: string; // Router address
  data: string; // Calldata
  value: string; // Native value (hex)
  chainId: number;
  gas?: string; // Gas limit estimate
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  deadline: number; // Unix timestamp
  needsApproval?: boolean; // Whether approval is needed
  approvalTransactions?: ApprovalTx[]; // V4: may need Permit2 + Router approvals
  // Legacy single approval (kept for backward compat)
  approvalTransaction?: ApprovalTx;
}

/**
 * Broadcast Response
 */
export interface BroadcastResponse {
  txHash: string;
  explorerUrl: string;
}

/**
 * Transaction Receipt Summary
 */
export interface ReceiptSummary {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  status: 'success' | 'failed';
  explorerUrl: string;
  fromToken: string;
  toToken: string;
  amountIn: string;
  amountOut: string;
}

/**
 * Validation Result
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Guardrail Result
 */
export interface GuardrailResult {
  passed: boolean;
  errors?: string[];
  warnings?: string[];
}

/**
 * Chat Message
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tradeIntent?: TradeIntent;
  quote?: Quote;
  txHash?: string;
  receiptSummary?: ReceiptSummary;
}

/**
 * Trade History Entry
 */
export interface TradeHistoryEntry {
  id: string;
  timestamp: number;
  intent: TradeIntent;
  quote: Quote;
  txHash: string;
  receipt?: ReceiptSummary;
  status: 'pending' | 'confirmed' | 'failed';
}

// ─── Prediction Market Types ─────────────────────────────────────────────────

export const PredictionIntentSchema = z.object({
  action: z.enum(['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO', 'INFO']),
  marketQuery: z.string().min(1),           // Natural language description of the market
  amountUsd: z.number().positive().optional(), // USD amount to wager
  slug: z.string().optional(),              // Polymarket event slug if known
});

export type PredictionIntent = z.infer<typeof PredictionIntentSchema>;

/**
 * Unified intent — the LLM first classifies whether the user wants
 * a swap/trade or a prediction market action.
 */
export const UnifiedIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('trade'), trade: TradeIntentSchema }),
  z.object({ type: z.literal('prediction'), prediction: PredictionIntentSchema }),
]);

export type UnifiedIntent = z.infer<typeof UnifiedIntentSchema>;

/**
 * OAuth Session
 */
export interface OAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  walletAddress?: string;
}

/**
 * MCP Tool Response Types
 */
export interface GetPayerAddrResponse {
  payer_addr: string;
}

export interface ApprovePaymentResponse {
  x_payment: string;
}

export interface SignTransactionResponse {
  signed_transaction: string;
}

export interface SignTypedDataResponse {
  signature: string;
}

/**
 * Stored trade record
 */
export interface TradeRecord {
  trade_id: string;
  command: string;
  trade_tx_hash: string | null;
  status: 'pending' | 'success' | 'failed';
  gas_used: string | null;
  gas_cost_usd: number | null;
  compute_cost_usd: number | null;
  builder_code: string | null;
  created_at: string;
}

// ─── Polymarket Trade Types ──────────────────────────────────────────────────

/**
 * Parameters for a Polymarket prediction market trade
 */
export interface PolymarketTradeParams {
  action: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO';
  marketSlug: string;
  marketQuestion: string;
  tokenId: string;        // CLOB token ID for the chosen outcome
  amountUsd: number;      // USD amount to trade
  price: number;          // Best available price (0-1)
  side: 'BUY' | 'SELL';
  negRisk: boolean;       // Whether the market uses neg-risk exchange
  feeRateBps: number;     // Fee rate in basis points
}

/**
 * EIP-712 order message for Polymarket CLOB
 */
export interface PolymarketOrderMessage {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: 'BUY' | 'SELL';
  signatureType: number;  // 0 = EOA (MetaMask)
}

/**
 * Polymarket CLOB API credentials (stored client-side per wallet)
 */
export interface PolymarketApiCreds {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

/**
 * Aggregated stats for the dashboard
 */
export interface AgentStats {
  agent_address: string;
  balances: {
    eth: string;
    usdc: string;
  };
  totals: {
    gas_spend_usd: number;
    compute_spend_usd: number;
    net_profit_usd: number;
    trade_count: number;
    failed_trade_count: number;
  };
  recent_trades: TradeRecord[];
}
