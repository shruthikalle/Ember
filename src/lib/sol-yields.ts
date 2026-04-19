/**
 * Shared types and helpers for SOL staking yield aggregation.
 *
 * Ember's wallet is EVM-only, so SOL staking is presented as a read-only
 * rate board that deep links out to each protocol's own staking UI.
 */

export interface SolPool {
  pool: string; // DeFi Llama pool id
  project: string; // e.g. 'jito'
  displayName: string; // e.g. 'Jito'
  symbol: string; // e.g. 'JITOSOL'
  apy: number;
  apyBase: number;
  apyReward: number;
  tvlUsd: number;
  chain: string; // 'Solana'
  llamaUrl: string; // https://defillama.com/yields/pool/{pool}
  protocolUrl: string; // deep link to the protocol's own staking UI
}

/**
 * Map of DeFi Llama project slug -> protocol's own staking page.
 * If a project is not in the map, callers should fall back to `llamaUrl`.
 */
export const PROTOCOL_URLS: Record<string, string> = {
  // Canonical slugs from the task spec
  'jito': 'https://www.jito.network/staking/',
  'marinade-finance': 'https://marinade.finance/app/staking/',
  'marinade-native': 'https://marinade.finance/app/staking/native/',
  'blazestake': 'https://stake.solblaze.org/app/',
  'jpool': 'https://jpool.one/',
  'sanctum-infinity': 'https://app.sanctum.so/infinity',
  'binance-staked-sol': 'https://www.binance.com/en/staking',
  // Aliases for DeFi Llama's current project slugs
  'jito-liquid-staking': 'https://www.jito.network/staking/',
  'marinade-liquid-staking': 'https://marinade.finance/app/staking/',
};

/**
 * Turn a DeFi Llama project slug into a display-friendly name.
 *
 * Examples:
 *   'marinade-native'     -> 'Marinade Native'
 *   'jito'                -> 'Jito'
 *   'sanctum-infinity'    -> 'Sanctum Infinity'
 */
export function formatProtocolName(project: string): string {
  if (!project) return '';
  return project
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
