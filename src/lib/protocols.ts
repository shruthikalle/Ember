/**
 * Multi-protocol USDC lending router.
 *
 * Gives the UI a single adapter interface over every executable USDC lending
 * market we integrate with on Base. For protocols where we don't yet have
 * transaction builders (Morpho Blue, Fluid, Spark), `getUsdcAdapter` returns
 * null — callers should fall back to the highest-yielding executable protocol.
 */

import {
  buildAaveSupplyTx,
  buildAaveWithdrawTx,
  buildUsdcApprovalTx as buildAaveApprovalTx,
  getAaveUsdcBalance,
  getAaveUsdcSupplyApy,
  getUsdcAllowance as getAaveUsdcAllowance,
  type UnsignedTx,
} from './aave';
import {
  buildCompoundApprovalTx,
  buildCompoundSupplyTx,
  buildCompoundWithdrawTx,
  getCompoundUsdcAllowance,
  getCompoundUsdcBalance,
  getCompoundUsdcSupplyApy,
} from './compound';
import {
  buildMoonwellApprovalTx,
  buildMoonwellSupplyTx,
  buildMoonwellWithdrawTx,
  buildMoonwellWithdrawAllTx,
  getMoonwellUsdcAllowance,
  getMoonwellUsdcBalance,
  getMoonwellUsdcSupplyApy,
} from './moonwell';

export type { UnsignedTx };

export type ProtocolId =
  | 'aave-v3'
  | 'compound-v3'
  | 'moonwell'
  | 'morpho-blue'
  | 'fluid-lending'
  | 'spark';

export type Asset = 'USDC';

export interface ProtocolAdapter {
  id: ProtocolId;
  displayName: string;
  supportsExecution: boolean;
  getAllowance(user: string): Promise<number>;
  buildApprovalTx(amount: number): UnsignedTx;
  buildSupplyTx(user: string, amount: number): UnsignedTx;
  /** May be async for protocols that need an on-chain read (e.g. Moonwell withdraw-all). */
  buildWithdrawTx(user: string, amount?: number): UnsignedTx | Promise<UnsignedTx>;
  getSuppliedBalance(user: string): Promise<number>;
  getSupplyApy(): Promise<number>;
}

export const EXECUTABLE_USDC_PROTOCOLS: ProtocolId[] = [
  'aave-v3',
  'compound-v3',
  'moonwell',
];

const aaveAdapter: ProtocolAdapter = {
  id: 'aave-v3',
  displayName: 'Aave v3',
  supportsExecution: true,
  getAllowance: (user) => getAaveUsdcAllowance(user),
  buildApprovalTx: (amount) => buildAaveApprovalTx(amount),
  buildSupplyTx: (user, amount) => buildAaveSupplyTx(user, amount),
  buildWithdrawTx: (user, amount) => buildAaveWithdrawTx(user, amount),
  getSuppliedBalance: (user) => getAaveUsdcBalance(user),
  getSupplyApy: () => getAaveUsdcSupplyApy(),
};

const compoundAdapter: ProtocolAdapter = {
  id: 'compound-v3',
  displayName: 'Compound v3',
  supportsExecution: true,
  getAllowance: (user) => getCompoundUsdcAllowance(user),
  buildApprovalTx: (amount) => buildCompoundApprovalTx(amount),
  buildSupplyTx: (user, amount) => buildCompoundSupplyTx(user, amount),
  buildWithdrawTx: (user, amount) => buildCompoundWithdrawTx(user, amount),
  getSuppliedBalance: (user) => getCompoundUsdcBalance(user),
  getSupplyApy: () => getCompoundUsdcSupplyApy(),
};

const moonwellAdapter: ProtocolAdapter = {
  id: 'moonwell',
  displayName: 'Moonwell',
  supportsExecution: true,
  getAllowance: (user) => getMoonwellUsdcAllowance(user),
  buildApprovalTx: (amount) => buildMoonwellApprovalTx(amount),
  buildSupplyTx: (user, amount) => buildMoonwellSupplyTx(user, amount),
  // Withdraw-all must use redeem(mTokenBalance) — not redeemUnderlying(maxUint256).
  // buildMoonwellWithdrawAllTx reads the actual mToken balance on-chain first.
  buildWithdrawTx: (user, amount) =>
    amount === undefined
      ? buildMoonwellWithdrawAllTx(user)
      : buildMoonwellWithdrawTx(user, amount),
  getSuppliedBalance: (user) => getMoonwellUsdcBalance(user),
  getSupplyApy: () => getMoonwellUsdcSupplyApy(),
};

/**
 * Returns the adapter for a protocol, or null if we don't currently support
 * building transactions for that protocol.
 */
export function getUsdcAdapter(protocol: ProtocolId): ProtocolAdapter | null {
  switch (protocol) {
    case 'aave-v3':
      return aaveAdapter;
    case 'compound-v3':
      return compoundAdapter;
    case 'moonwell':
      return moonwellAdapter;
    case 'morpho-blue':
    case 'fluid-lending':
    case 'spark':
      return null;
    default:
      return null;
  }
}

/**
 * Convenience: returns every adapter we can execute against.
 */
export function getAllExecutableUsdcAdapters(): ProtocolAdapter[] {
  return EXECUTABLE_USDC_PROTOCOLS.map((id) => getUsdcAdapter(id)).filter(
    (a): a is ProtocolAdapter => a !== null,
  );
}
