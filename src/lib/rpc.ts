import { ethers } from 'ethers';

// Base RPC for Uniswap/blockchain operations
// Only use RPC URL from environment variables (no fallbacks)
const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL;

// Read from env so it stays in sync with tokens.ts / wallet.ts
const BASE_CHAIN_ID = parseInt(process.env.CHAIN_ID || process.env.NEXT_PUBLIC_CHAIN_ID || '8453', 10);

/**
 * Get ethers provider for Base (used for Uniswap transactions)
 * Only uses RPC URL from environment variables
 */
export function getProvider(): ethers.JsonRpcProvider {
  if (!BASE_RPC_URL) {
    throw new Error('NEXT_PUBLIC_BASE_RPC_URL or NEXT_PUBLIC_RPC_URL must be set in environment variables');
  }
  console.log('[RPC] Using Base RPC URL:', BASE_RPC_URL);
  return new ethers.JsonRpcProvider(BASE_RPC_URL);
}

/**
 * Get provider with connection test
 * Only uses RPC URL from environment variables
 */
export async function getProviderWithRetry(): Promise<ethers.JsonRpcProvider> {
  if (!BASE_RPC_URL) {
    throw new Error('NEXT_PUBLIC_BASE_RPC_URL or NEXT_PUBLIC_RPC_URL must be set in environment variables');
  }
  
  console.log('[RPC] Connecting to Base RPC:', BASE_RPC_URL);
  
  // Retry up to 3 times with exponential backoff (public RPCs can be flaky)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, 8453, {
        staticNetwork: true,
      });
      const blockNumber = await provider.getBlockNumber();
      console.log(`[RPC] ✅ Connected (block: ${blockNumber})`);
      return provider;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (attempt < 3) {
        const delay = 500 * attempt;
        console.warn(`[RPC] ⚠️ Attempt ${attempt}/3 failed: ${errorMsg.slice(0, 100)}, retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(`[RPC] ❌ All 3 attempts failed:`, errorMsg);
        throw new Error(`Failed to connect to Base RPC after 3 attempts: ${errorMsg}. Check NEXT_PUBLIC_BASE_RPC_URL.`);
      }
    }
  }
  // unreachable but TypeScript needs it
  throw new Error('Failed to connect to RPC');
}

/**
 * Get chain ID for blockchain operations (Base)
 */
export function getChainId(): number {
  return BASE_CHAIN_ID;
}

/**
 * Broadcast signed transaction with retry logic
 */
export async function broadcastTransaction(signedTx: string): Promise<{ txHash: string; explorerUrl: string }> {
  const provider = await getProviderWithRetry();
  
  try {
    // Send raw transaction
    const tx = await provider.broadcastTransaction(signedTx);
    
    // Build explorer URL for Base (where transactions are executed)
    const explorerUrl = `https://basescan.org/tx/${tx.hash}`;
    
    return {
      txHash: tx.hash,
      explorerUrl,
    };
  } catch (error) {
    console.error('[RPC] ❌ Failed to broadcast transaction:', error);
    throw new Error(`Failed to broadcast transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Wait for transaction receipt with retry logic
 */
export async function waitForReceipt(txHash: string, confirmations: number = 1): Promise<ethers.TransactionReceipt | null> {
  console.log(`[RPC] Waiting for transaction receipt: ${txHash} (confirmations: ${confirmations})`);
  const provider = await getProviderWithRetry();
  const receipt = await provider.waitForTransaction(txHash, confirmations);
  if (receipt) {
    console.log(`[RPC] ✅ Transaction receipt received, block: ${receipt.blockNumber}, status: ${receipt.status === 1 ? 'success' : 'failed'}`);
  }
  return receipt;
}

/**
 * Get transaction receipt with retry logic
 */
export async function getReceipt(txHash: string): Promise<ethers.TransactionReceipt | null> {
  console.log(`[RPC] Getting transaction receipt: ${txHash}`);
  const provider = await getProviderWithRetry();
  const receipt = await provider.getTransactionReceipt(txHash);
  if (receipt) {
    console.log(`[RPC] ✅ Transaction receipt found, block: ${receipt.blockNumber}, status: ${receipt.status === 1 ? 'success' : 'failed'}`);
  } else {
    console.log(`[RPC] ⚠️ Transaction receipt not yet available`);
  }
  return receipt;
}
