/**
 * WETH lending helpers on Base: Aave v3 + Compound v3.
 *
 * WETH is wrapped ETH — users need to wrap ETH → WETH before supplying
 * to Aave or Compound, and unwrap on withdrawal to get native ETH back.
 *
 * Provides unsigned tx builders for the full flow (wrap / approve / supply
 * / withdraw / unwrap) and read-only helpers for balances and APYs.
 */

import { ethers } from 'ethers';

export const WETH_BASE: string = '0x4200000000000000000000000000000000000006';
export const AAVE_V3_POOL_BASE: string = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
export const AWETH_BASE: string = '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7';
export const COMPOUND_V3_CWETH_BASE: string = '0x46e6b214b524310239732D51387075E0e70970bf';
export const BASE_RPC: string = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://base.llamarpc.com';
export const BASE_CHAIN_ID: number = 8453;

const WETH_DECIMALS = 18;
const RAY = 10n ** 27n;
const SCALE_1E18 = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;
const MAX_UINT256 = (1n << 256n) - 1n;

const WETH_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

const COMPOUND_V3_ABI = [
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function getSupplyRate(uint256 utilization) view returns (uint64)',
  'function getUtilization() view returns (uint256)',
];

export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

const wethInterface = new ethers.Interface(WETH_ABI);
const aavePoolInterface = new ethers.Interface(AAVE_POOL_ABI);
const compoundInterface = new ethers.Interface(COMPOUND_V3_ABI);

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID);
}

function toWethUnits(amountEth: number): bigint {
  if (!Number.isFinite(amountEth) || amountEth < 0) {
    throw new Error(`Invalid ETH amount: ${amountEth}`);
  }
  return ethers.parseUnits(amountEth.toFixed(WETH_DECIMALS), WETH_DECIMALS);
}

function fromWethUnits(raw: bigint): number {
  return Number(ethers.formatUnits(raw, WETH_DECIMALS));
}

function toHexValue(wei: bigint): string {
  return '0x' + wei.toString(16);
}

/**
 * Wrap ETH → WETH. Calls deposit() on the WETH contract with value = wei.
 */
export function buildWrapEthTx(amountEth: number): UnsignedTx {
  const value = toWethUnits(amountEth);
  const data = wethInterface.encodeFunctionData('deposit', []);
  return {
    to: WETH_BASE,
    data,
    value: toHexValue(value),
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Unwrap WETH → ETH. Calls withdraw(amount) on the WETH contract.
 */
export function buildUnwrapWethTx(amountEth: number): UnsignedTx {
  const amount = toWethUnits(amountEth);
  const data = wethInterface.encodeFunctionData('withdraw', [amount]);
  return {
    to: WETH_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Standard ERC20 approval of WETH to a spender (e.g. Aave pool or Compound).
 */
export function buildWethApprovalTx(spender: string, amountEth: number): UnsignedTx {
  const amount = toWethUnits(amountEth);
  const data = wethInterface.encodeFunctionData('approve', [spender, amount]);
  return {
    to: WETH_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Aave v3 supply(WETH, amount, onBehalfOf, 0) on Base.
 */
export function buildAaveWethSupplyTx(userAddress: string, amountEth: number): UnsignedTx {
  const amount = toWethUnits(amountEth);
  const data = aavePoolInterface.encodeFunctionData('supply', [
    WETH_BASE,
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
 * Aave v3 withdraw(WETH, amount, to) on Base. Omit amountEth to withdraw
 * everything (uses uint256 max as a sentinel per Aave v3 semantics).
 */
export function buildAaveWethWithdrawTx(
  userAddress: string,
  amountEth?: number,
): UnsignedTx {
  const amount = amountEth === undefined ? MAX_UINT256 : toWethUnits(amountEth);
  const data = aavePoolInterface.encodeFunctionData('withdraw', [
    WETH_BASE,
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
 * Current aWETH balance for a user — rebasing, already includes interest.
 */
export async function getAaveWethBalance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const aToken = new ethers.Contract(AWETH_BASE, ERC20_ABI, provider);
    const raw: bigint = await aToken.balanceOf(userAddress);
    return fromWethUnits(raw);
  } catch {
    return 0;
  }
}

/**
 * Compound v3 cWETHv3.supply(WETH, amount) on Base.
 */
export function buildCompoundWethSupplyTx(
  userAddress: string,
  amountEth: number,
): UnsignedTx {
  void userAddress;
  const amount = toWethUnits(amountEth);
  const data = compoundInterface.encodeFunctionData('supply', [WETH_BASE, amount]);
  return {
    to: COMPOUND_V3_CWETH_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Compound v3 cWETHv3.withdraw(WETH, amount) on Base. Omit amountEth to
 * withdraw everything (uses uint256 max).
 */
export function buildCompoundWethWithdrawTx(
  userAddress: string,
  amountEth?: number,
): UnsignedTx {
  void userAddress;
  const amount = amountEth === undefined ? MAX_UINT256 : toWethUnits(amountEth);
  const data = compoundInterface.encodeFunctionData('withdraw', [WETH_BASE, amount]);
  return {
    to: COMPOUND_V3_CWETH_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Current Compound v3 cWETHv3 balance for a user. balanceOf on Compound v3
 * is accrual-adjusted — it already reflects accrued interest.
 */
export async function getCompoundWethBalance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const comet = new ethers.Contract(COMPOUND_V3_CWETH_BASE, COMPOUND_V3_ABI, provider);
    const raw: bigint = await comet.balanceOf(userAddress);
    return fromWethUnits(raw);
  } catch {
    return 0;
  }
}

/**
 * Current WETH allowance from the user to a spender, in ETH units.
 */
export async function getWethAllowance(
  userAddress: string,
  spender: string,
): Promise<number> {
  try {
    const provider = getProvider();
    const weth = new ethers.Contract(WETH_BASE, WETH_ABI, provider);
    const raw: bigint = await weth.allowance(userAddress, spender);
    return fromWethUnits(raw);
  } catch {
    return 0;
  }
}

/**
 * Current supply APY for WETH on Aave v3 Base, as a percentage.
 * Reads currentLiquidityRate (Ray, 1e27) and converts to a simple % — we
 * intentionally skip continuous compounding for display stability.
 */
export async function getAaveWethSupplyApy(): Promise<number> {
  try {
    const provider = getProvider();
    const pool = new ethers.Contract(AAVE_V3_POOL_BASE, AAVE_POOL_ABI, provider);
    const data = await pool.getReserveData(WETH_BASE);
    const liquidityRate: bigint = data.currentLiquidityRate ?? data[2];
    if (liquidityRate === undefined || liquidityRate === null) {
      return 0;
    }
    const pctScaled = (liquidityRate * 10_000n) / RAY; // basis points
    return Number(pctScaled) / 100;
  } catch {
    return 0;
  }
}

/**
 * Current supply APY for WETH on Compound v3 (cWETHv3) on Base, as a
 * percentage. Reads utilization → per-second supply rate (scaled 1e18),
 * annualizes, and returns a %.
 */
export async function getCompoundWethSupplyApy(): Promise<number> {
  try {
    const provider = getProvider();
    const comet = new ethers.Contract(
      COMPOUND_V3_CWETH_BASE,
      COMPOUND_V3_ABI,
      provider,
    );
    const utilization: bigint = await comet.getUtilization();
    const supplyRatePerSec: bigint = await comet.getSupplyRate(utilization);
    // Annualize: ratePerSec * secondsPerYear / 1e18 → fraction → * 100 for %.
    const annualScaled = (supplyRatePerSec * SECONDS_PER_YEAR * 10_000n) / SCALE_1E18;
    return Number(annualScaled) / 100;
  } catch {
    return 0;
  }
}
