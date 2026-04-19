/**
 * Compound v3 (Comet) helpers for USDC on Base.
 *
 * Targets the cUSDCv3 Comet market. In Compound v3 the Comet contract itself
 * is the ERC20 spender for the base asset (USDC), and user balances from
 * `balanceOf` already include accrued supply interest.
 */

import { ethers } from 'ethers';

export const COMPOUND_COMET_USDC_BASE: string =
  '0xb125E6687d4313864e53df431d5425969c15Eb2F';
export const USDC_BASE: string = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_RPC: string = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://base.llamarpc.com';
export const BASE_CHAIN_ID: number = 8453;

const USDC_DECIMALS = 6;
const SECONDS_PER_YEAR = 31_536_000n;
const RATE_SCALE = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;

const COMET_ABI = [
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function getUtilization() view returns (uint256)',
  'function getSupplyRate(uint256 utilization) view returns (uint64)',
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

const cometInterface = new ethers.Interface(COMET_ABI);
const erc20Interface = new ethers.Interface(ERC20_ABI);

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID);
}

function toUsdcUnits(amountUsdc: number): bigint {
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) {
    throw new Error(`Invalid USDC amount: ${amountUsdc}`);
  }
  return ethers.parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

function fromUsdcUnits(raw: bigint): number {
  return Number(ethers.formatUnits(raw, USDC_DECIMALS));
}

/**
 * User's USDC supply balance on Compound v3 Base (auto-accrues interest).
 */
export async function getCompoundUsdcBalance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const comet = new ethers.Contract(COMPOUND_COMET_USDC_BASE, COMET_ABI, provider);
    const raw: bigint = await comet.balanceOf(userAddress);
    return fromUsdcUnits(raw);
  } catch (err) {
    console.warn('[compound] balance lookup failed:', err);
    return 0;
  }
}

/**
 * Current supply APY (%) on Compound v3 USDC Base.
 * supplyRate is per-second, scaled by 1e18. APY = rate * SECONDS_PER_YEAR / 1e18 * 100.
 */
export async function getCompoundUsdcSupplyApy(): Promise<number> {
  try {
    const provider = getProvider();
    const comet = new ethers.Contract(COMPOUND_COMET_USDC_BASE, COMET_ABI, provider);
    const utilization: bigint = await comet.getUtilization();
    const rate: bigint = await comet.getSupplyRate(utilization);
    // basis points precision before float convert
    const bpsScaled = (rate * SECONDS_PER_YEAR * 10_000n) / RATE_SCALE;
    return Number(bpsScaled) / 100;
  } catch (err) {
    console.warn('[compound] apy lookup failed:', err);
    return 0;
  }
}

/**
 * USDC allowance from user to the Comet contract.
 */
export async function getCompoundUsdcAllowance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, provider);
    const raw: bigint = await usdc.allowance(userAddress, COMPOUND_COMET_USDC_BASE);
    return fromUsdcUnits(raw);
  } catch (err) {
    console.warn('[compound] allowance lookup failed:', err);
    return 0;
  }
}

/**
 * ERC20 approve USDC to the Comet contract (Compound v3 spender is the market itself).
 */
export function buildCompoundApprovalTx(amountUsdc: number): UnsignedTx {
  const amount = toUsdcUnits(amountUsdc);
  const data = erc20Interface.encodeFunctionData('approve', [
    COMPOUND_COMET_USDC_BASE,
    amount,
  ]);
  return {
    to: USDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Unsigned Compound v3 supply of USDC.
 */
export function buildCompoundSupplyTx(
  _userAddress: string,
  amountUsdc: number,
): UnsignedTx {
  const amount = toUsdcUnits(amountUsdc);
  const data = cometInterface.encodeFunctionData('supply', [USDC_BASE, amount]);
  return {
    to: COMPOUND_COMET_USDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Unsigned Compound v3 withdraw. Omit amount to withdraw everything
 * (uses uint256 max so Comet returns the user's full supply balance).
 */
export function buildCompoundWithdrawTx(
  _userAddress: string,
  amountUsdc?: number,
): UnsignedTx {
  const amount = amountUsdc === undefined ? MAX_UINT256 : toUsdcUnits(amountUsdc);
  const data = cometInterface.encodeFunctionData('withdraw', [USDC_BASE, amount]);
  return {
    to: COMPOUND_COMET_USDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}
