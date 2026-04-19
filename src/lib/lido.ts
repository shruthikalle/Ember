/**
 * Lido stETH helpers (Ethereum mainnet only).
 *
 * Provides read-only queries for stETH balances + current APR and builds the
 * unsigned deposit transaction for submit(referral). stETH is a rebasing
 * ERC20, so balanceOf already reflects accrued rewards.
 *
 * NOTE: Unstaking stETH goes through Lido's withdrawal queue and can take
 * several days to settle. This module intentionally does NOT build an
 * unstake transaction — for immediate exits users should swap stETH → ETH
 * on a DEX (Curve / Uniswap), which is out of scope here.
 */

import { ethers } from 'ethers';

export const LIDO_CONTRACT: string = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
export const MAINNET_CHAIN_ID: number = 1;
export const MAINNET_RPC: string = 'https://eth.llamarpc.com';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const LIDO_APR_URL = 'https://eth-api.lido.fi/v1/protocol/steth/apr/last';
const FALLBACK_APR = 3.2;

const LIDO_ABI = [
  'function submit(address _referral) payable returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

const lidoInterface = new ethers.Interface(LIDO_ABI);

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(MAINNET_RPC, MAINNET_CHAIN_ID);
}

function toEthWei(amountEth: number): bigint {
  if (!Number.isFinite(amountEth) || amountEth < 0) {
    throw new Error(`Invalid ETH amount: ${amountEth}`);
  }
  return ethers.parseUnits(amountEth.toFixed(18), 18);
}

function fromEthWei(raw: bigint): number {
  return Number(ethers.formatUnits(raw, 18));
}

/**
 * Unsigned Lido stake transaction. Calls submit(referral) with msg.value =
 * amount in wei. Zero-address referral means no referral credit.
 */
export function buildLidoStakeTx(userAddress: string, amountEth: number): UnsignedTx {
  // userAddress isn't passed into submit() — Lido credits msg.sender, which
  // will be the user when they broadcast. We accept the param to match the
  // broader UnsignedTx builder shape used elsewhere in the app.
  void userAddress;

  const value = toEthWei(amountEth);
  const data = lidoInterface.encodeFunctionData('submit', [ZERO_ADDRESS]);
  return {
    to: LIDO_CONTRACT,
    data,
    value: '0x' + value.toString(16),
    chainId: MAINNET_CHAIN_ID,
  };
}

/**
 * Current stETH balance for a user, in ETH units. stETH is rebasing so this
 * value already reflects staking rewards.
 */
export async function getLidoStEthBalance(userAddress: string): Promise<number> {
  try {
    const provider = getProvider();
    const steth = new ethers.Contract(LIDO_CONTRACT, LIDO_ABI, provider);
    const raw: bigint = await steth.balanceOf(userAddress);
    return fromEthWei(raw);
  } catch {
    return 0;
  }
}

interface LidoAprResponse {
  data?: {
    apr?: number;
    timeUnix?: number;
  };
}

/**
 * Current Lido stETH APR as a percentage (e.g. 3.5 means 3.5%). Falls back
 * to a conservative static value if the public API is unreachable.
 */
export async function getLidoApr(): Promise<number> {
  try {
    const res = await fetch(LIDO_APR_URL, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return FALLBACK_APR;
    }
    const payload = (await res.json()) as LidoAprResponse;
    const apr = payload?.data?.apr;
    if (typeof apr === 'number' && Number.isFinite(apr) && apr > 0) {
      return apr;
    }
    return FALLBACK_APR;
  } catch {
    return FALLBACK_APR;
  }
}
