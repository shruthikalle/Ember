/**
 * Moonwell (Compound v2 fork) USDC market helpers on Base.
 *
 * Uses the mUSDC mToken. mToken balances are denominated in mTokens, so we
 * convert to underlying USDC using the stored exchange rate. Supplies/withdraws
 * go through mint / redeemUnderlying / redeem on the mToken itself.
 */

import { ethers } from 'ethers';

export const MOONWELL_MUSDC_BASE: string =
  '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22';
export const USDC_BASE: string = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_RPC: string = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://base.llamarpc.com';
export const BASE_CHAIN_ID: number = 8453;

const USDC_DECIMALS = 6;
const SECONDS_PER_YEAR = 31_536_000n;
const RATE_SCALE = 10n ** 18n;

const MTOKEN_ABI = [
  'function mint(uint256 mintAmount) returns (uint256)',
  'function redeem(uint256 redeemTokens) returns (uint256)',
  'function redeemUnderlying(uint256 redeemAmount) returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function balanceOfUnderlying(address account) returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function supplyRatePerTimestamp() view returns (uint256)',
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

const mTokenInterface = new ethers.Interface(MTOKEN_ABI);
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
 * Underlying USDC balance supplied by user on Moonwell.
 *
 * Prefers `balanceOfUnderlying` via staticCall (it mutates storage so it isn't
 * a pure view). Falls back to `balanceOf * exchangeRateStored / 1e18`, which
 * gives a slightly stale but close number when the non-view call is unavailable.
 */
export async function getMoonwellUsdcBalance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const mToken = new ethers.Contract(MOONWELL_MUSDC_BASE, MTOKEN_ABI, provider);

    try {
      const raw: bigint = await mToken.balanceOfUnderlying.staticCall(userAddress);
      return fromUsdcUnits(raw);
    } catch {
      const [mBalance, rate]: [bigint, bigint] = await Promise.all([
        mToken.balanceOf(userAddress),
        mToken.exchangeRateStored(),
      ]);
      // underlying = mBalance * rate / 1e18, but already in underlying decimals (6)
      const underlying = (mBalance * rate) / RATE_SCALE;
      return fromUsdcUnits(underlying);
    }
  } catch (err) {
    console.warn('[moonwell] balance lookup failed:', err);
    return 0;
  }
}

/**
 * Current supply APY (%) on Moonwell USDC.
 *
 * supplyRatePerTimestamp is per-second and scaled by 1e18. We annualize simply
 * (rate * seconds / 1e18 * 100) — continuous compounding of a very small
 * per-second rate across 31.5M periods overflows plain JS numbers with bigint
 * exponents and the simple linearization is what the UI shows today anyway.
 */
export async function getMoonwellUsdcSupplyApy(): Promise<number> {
  try {
    const provider = getProvider();
    const mToken = new ethers.Contract(MOONWELL_MUSDC_BASE, MTOKEN_ABI, provider);
    const rate: bigint = await mToken.supplyRatePerTimestamp();
    const bpsScaled = (rate * SECONDS_PER_YEAR * 10_000n) / RATE_SCALE;
    return Number(bpsScaled) / 100;
  } catch (err) {
    console.warn('[moonwell] apy lookup failed:', err);
    return 0;
  }
}

/**
 * USDC allowance from user to the Moonwell mUSDC contract.
 */
export async function getMoonwellUsdcAllowance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, provider);
    const raw: bigint = await usdc.allowance(userAddress, MOONWELL_MUSDC_BASE);
    return fromUsdcUnits(raw);
  } catch (err) {
    console.warn('[moonwell] allowance lookup failed:', err);
    return 0;
  }
}

/**
 * ERC20 approve USDC to the Moonwell mUSDC contract.
 */
export function buildMoonwellApprovalTx(amountUsdc: number): UnsignedTx {
  const amount = toUsdcUnits(amountUsdc);
  const data = erc20Interface.encodeFunctionData('approve', [
    MOONWELL_MUSDC_BASE,
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
 * Unsigned Moonwell mint (supply USDC).
 */
export function buildMoonwellSupplyTx(
  _userAddress: string,
  amountUsdc: number,
): UnsignedTx {
  const amount = toUsdcUnits(amountUsdc);
  const data = mTokenInterface.encodeFunctionData('mint', [amount]);
  return {
    to: MOONWELL_MUSDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Unsigned Moonwell redeem.
 * - With an amount, uses redeemUnderlying(uint256) — specify USDC amount directly.
 * - Without an amount, uses redeem(uint256) on the user's full mToken balance
 *   to drain the entire position. We pre-read balanceOf(user) to fill it in.
 *   Because this requires an RPC read, it's async in the adapter layer; the
 *   sync builder here returns a redeemUnderlying max as a best-effort sentinel.
 *
 * For a true "withdraw all", prefer `buildMoonwellWithdrawAllTx` below.
 */
export function buildMoonwellWithdrawTx(
  _userAddress: string,
  amountUsdc?: number,
): UnsignedTx {
  if (amountUsdc === undefined) {
    // Use a large sentinel; Moonwell will revert on insufficient — callers
    // wanting "withdraw all" should prefer buildMoonwellWithdrawAllTx.
    const data = mTokenInterface.encodeFunctionData('redeemUnderlying', [
      (1n << 255n) - 1n,
    ]);
    return {
      to: MOONWELL_MUSDC_BASE,
      data,
      value: '0x0',
      chainId: BASE_CHAIN_ID,
    };
  }
  const amount = toUsdcUnits(amountUsdc);
  const data = mTokenInterface.encodeFunctionData('redeemUnderlying', [amount]);
  return {
    to: MOONWELL_MUSDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Async "withdraw everything" helper — reads the user's mToken balance and
 * encodes redeem(uint256 mTokenBalance). Preferred for full exits.
 *
 * In browser context the wallet's own provider (window.ethereum) is used for
 * the eth_call so we avoid CORS / rate-limit issues with the public RPC URL.
 */
export async function buildMoonwellWithdrawAllTx(
  userAddress: string,
): Promise<UnsignedTx> {
  let mBalance: bigint;

  if (typeof window !== 'undefined' && (window as any).ethereum) {
    // Use the already-connected wallet provider — no separate RPC needed.
    const eth = (window as any).ethereum;
    // balanceOf(address) selector = 0x70a08231, address left-padded to 32 bytes
    const callData = `0x70a08231${userAddress.slice(2).toLowerCase().padStart(64, '0')}`;
    const result: string = await eth.request({
      method: 'eth_call',
      params: [{ to: MOONWELL_MUSDC_BASE, data: callData }, 'latest'],
    });
    mBalance = BigInt(result === '0x' ? '0x0' : result);
  } else {
    // Server-side fallback (e.g. positions API).
    const provider = getProvider();
    const mToken = new ethers.Contract(MOONWELL_MUSDC_BASE, MTOKEN_ABI, provider);
    mBalance = await mToken.balanceOf(userAddress);
  }

  if (mBalance === 0n) {
    throw new Error('No Moonwell mUSDC balance found — nothing to withdraw.');
  }

  const data = mTokenInterface.encodeFunctionData('redeem', [mBalance]);
  return {
    to: MOONWELL_MUSDC_BASE,
    data,
    value: '0x0',
    chainId: BASE_CHAIN_ID,
  };
}
