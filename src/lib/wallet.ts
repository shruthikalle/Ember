/**
 * Agent-owned EOA wallet.
 *
 * Reads AGENT_PRIVATE_KEY from env and constructs an ethers v6 Wallet
 * connected to the configured RPC provider.
 */

import { ethers } from 'ethers';

// ─── Config ─────────────────────────────────────────────────────────────────

function getChainConfig() {
  const id = parseInt(process.env.CHAIN_ID || '8453', 10);
  const rpcUrl =
    process.env.RPC_URL ||
    (id === 8453
      ? process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'
      : 'https://sepolia.base.org');
  return { chainId: id, rpcUrl };
}

export function getChainId(): number {
  return getChainConfig().chainId;
}

export function getExplorerBaseUrl(): string {
  return getChainId() === 8453
    ? 'https://basescan.org'
    : 'https://sepolia.basescan.org';
}

// ─── Provider + Signer ──────────────────────────────────────────────────────

let _provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (_provider) return _provider;
  const { rpcUrl, chainId } = getChainConfig();
  _provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  return _provider;
}

let _signer: ethers.Wallet | null = null;

export function getAgentSigner(): ethers.Wallet {
  if (_signer) return _signer;
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error('AGENT_PRIVATE_KEY env var is required');
  _signer = new ethers.Wallet(pk, getProvider());
  return _signer;
}

export function getAgentAddress(): string {
  return getAgentSigner().address;
}

// ─── Balance helpers ────────────────────────────────────────────────────────

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.code;
  return (
    code === -32016 ||
    code === 'UNKNOWN_ERROR' && msg.includes('over rate limit') ||
    msg.includes('rate limit') ||
    msg.includes('Too Many Requests') ||
    msg.includes('429')
  );
}

/**
 * Retry with exponential backoff for rate limit errors
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isRateLimitError(error) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`[Wallet] Rate limit error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}

export async function getEthBalance(): Promise<string> {
  return retryWithBackoff(async () => {
    const provider = getProvider();
    const bal = await provider.getBalance(getAgentAddress());
    return ethers.formatEther(bal);
  });
}

export async function getUsdcBalance(): Promise<string> {
  const usdcAddr = getUsdcAddress();
  if (!usdcAddr) return '0';
  return retryWithBackoff(async () => {
    const provider = getProvider();
    const token = new ethers.Contract(usdcAddr, ERC20_BALANCE_ABI, provider);
    const bal: bigint = await token.balanceOf(getAgentAddress());
    return ethers.formatUnits(bal, 6);
  });
}

// ─── Token addresses ────────────────────────────────────────────────────────

export function getUsdcAddress(): string {
  const id = getChainId();
  if (id === 8453) return process.env.USDC_ADDRESS_BASE || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  return process.env.USDC_ADDRESS_BASE_SEPOLIA || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
}

export function getUsdcDecimals(): number {
  return parseInt(process.env.USDC_DECIMALS || '6', 10);
}
