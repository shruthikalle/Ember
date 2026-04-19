/**
 * Aave v3 helpers for Base.
 *
 * Thin wrapper around ethers v6 that exposes read-only queries against the
 * Aave v3 Pool + aUSDC contracts, and builds unsigned transaction payloads
 * for supply / withdraw / approval flows. All balance-style numbers are
 * returned in USDC human units (6 decimals converted to a JS number).
 */

import { ethers } from 'ethers';

export const AAVE_V3_POOL_BASE: string = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
export const USDC_BASE: string = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const AUSDC_BASE: string = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
export const BASE_RPC: string = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://base.llamarpc.com';
export const BASE_CHAIN_ID: number = 8453;

const USDC_DECIMALS = 6;
const RAY = 10n ** 27n;
const MAX_UINT256 = (1n << 256n) - 1n;

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

const aavePoolInterface = new ethers.Interface(AAVE_POOL_ABI);
const erc20Interface = new ethers.Interface(ERC20_ABI);

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID);
}

function toUsdcUnits(amountUsdc: number): bigint {
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) {
    throw new Error(`Invalid USDC amount: ${amountUsdc}`);
  }
  // Format with 6 decimals as a fixed string to avoid fp noise.
  return ethers.parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

function fromUsdcUnits(raw: bigint): number {
  return Number(ethers.formatUnits(raw, USDC_DECIMALS));
}

/**
 * Returns an ethers.Contract bound to the Aave v3 Pool on Base (read-only).
 */
export function getAavePool(provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(AAVE_V3_POOL_BASE, AAVE_POOL_ABI, provider);
}

/**
 * Current aUSDC balance for a user — this is the rebasing balance, so it
 * already includes accrued interest.
 */
export async function getAaveUsdcBalance(userAddress: string): Promise<number> {
  const provider = getProvider();
  const aToken = new ethers.Contract(AUSDC_BASE, ERC20_ABI, provider);
  const raw: bigint = await aToken.balanceOf(userAddress);
  return fromUsdcUnits(raw);
}

/**
 * Current supply APY for USDC on Aave v3 Base, as a percentage.
 * We read currentLiquidityRate (Ray, 1e27) and convert to a simple % — this
 * intentionally skips continuous compounding to keep the display value stable.
 */
export async function getAaveUsdcSupplyApy(): Promise<number> {
  const provider = getProvider();
  const pool = getAavePool(provider);
  const data = await pool.getReserveData(USDC_BASE);
  const liquidityRate: bigint = data.currentLiquidityRate ?? data[2];
  if (liquidityRate === undefined || liquidityRate === null) {
    return 0;
  }
  // (liquidityRate / 1e27) * 100, computed in bigint precision before convert.
  const pctScaled = (liquidityRate * 10_000n) / RAY; // basis points
  return Number(pctScaled) / 100;
}

/**
 * Unsigned ERC20 approval of USDC to the Aave v3 pool.
 */
export function buildUsdcApprovalTx(amountUsdc: number): UnsignedTx {
  const amount = toUsdcUnits(amountUsdc);
  const data = erc20Interface.encodeFunctionData('approve', [AAVE_V3_POOL_BASE, amount]);
  return {
    to: USDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Unsigned Aave supply transaction.
 */
export function buildAaveSupplyTx(userAddress: string, amountUsdc: number): UnsignedTx {
  const amount = toUsdcUnits(amountUsdc);
  const data = aavePoolInterface.encodeFunctionData('supply', [
    USDC_BASE,
    amount,
    userAddress,
    0,
  ]);
  return {
    to: AAVE_V3_POOL_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Unsigned Aave withdraw transaction. Omit amountUsdc to withdraw everything
 * (uses uint256 max as a sentinel per Aave v3 semantics).
 */
export function buildAaveWithdrawTx(userAddress: string, amountUsdc?: number): UnsignedTx {
  const amount = amountUsdc === undefined ? MAX_UINT256 : toUsdcUnits(amountUsdc);
  const data = aavePoolInterface.encodeFunctionData('withdraw', [
    USDC_BASE,
    amount,
    userAddress,
  ]);
  return {
    to: AAVE_V3_POOL_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Current USDC allowance from the user to the Aave v3 pool.
 */
export async function getUsdcAllowance(userAddress: string): Promise<number> {
  const provider = getProvider();
  const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, provider);
  const raw: bigint = await usdc.allowance(userAddress, AAVE_V3_POOL_BASE);
  return fromUsdcUnits(raw);
}
