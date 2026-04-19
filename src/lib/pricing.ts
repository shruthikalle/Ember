/**
 * Cost accounting for the agent.
 *
 * - Gas cost: gasUsed * gasPrice * ETH_PRICE_USD
 * - Compute cost: estimated LLM token usage * cost-per-token
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const ETH_PRICE_USD = parseFloat(process.env.ETH_PRICE_USD || '2700');
const LLM_COST_PER_1K_TOKENS = 0.002; // $0.002 per 1K tokens (gpt-4o-mini equivalent)

// ─── Gas cost ───────────────────────────────────────────────────────────────

/**
 * Estimate gas cost in USD from a tx receipt.
 *
 * @param gasUsed      – gas units consumed (bigint or string)
 * @param gasPriceWei  – effective gas price in wei (bigint or string)
 * @returns cost in USD
 */
export function estimateGasCostUsd(
  gasUsed: bigint | string,
  gasPriceWei: bigint | string,
): number {
  const used = typeof gasUsed === 'string' ? BigInt(gasUsed) : gasUsed;
  const price = typeof gasPriceWei === 'string' ? BigInt(gasPriceWei) : gasPriceWei;
  // cost in ETH = (gasUsed * gasPrice) / 1e18
  const costWei = used * price;
  const costEth = Number(costWei) / 1e18;
  return costEth * ETH_PRICE_USD;
}

// ─── Compute cost ───────────────────────────────────────────────────────────

/**
 * Estimate LLM compute cost from token usage.
 *
 * @param tokenCount – total tokens (prompt + completion)
 * @returns cost in USD
 */
export function estimateComputeCostUsd(tokenCount: number): number {
  return (tokenCount / 1000) * LLM_COST_PER_1K_TOKENS;
}

/**
 * Deterministic token count estimate for the stub LLM.
 * Real implementation should use the actual token count from the API response.
 */
export function estimateTokenCount(command: string): number {
  // ~4 chars per token (rough heuristic) + system prompt overhead
  const commandTokens = Math.ceil(command.length / 4);
  const systemPromptTokens = 150; // approximate
  const completionTokens = 50;    // approximate
  return commandTokens + systemPromptTokens + completionTokens;
}

/**
 * Get the configured ETH price (for display / cost calc).
 */
export function getEthPriceUsd(): number {
  return ETH_PRICE_USD;
}
