/**
 * Token transfer builder for both EVM (Base) and Solana.
 *
 * Handles:
 *   - Native ETH transfers on Base
 *   - ERC-20 token transfers on Base (USDC, DAI, etc.)
 *   - Native SOL transfers on Solana
 *   - SPL token transfers on Solana (USDC, BONK, etc.)
 */

import { ethers } from 'ethers';
import { getToken, SOLANA_TOKENS } from './tokens';
import { SOLANA_MINTS, getSolanaDecimals } from './jupiter';

// ─── EVM Transfers (Base) ──────────────────────────────────────────────────

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

export interface EvmTransferTx {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

/**
 * Build an unsigned EVM transfer transaction (ETH or ERC-20).
 */
export function buildEvmTransfer(
  tokenSymbol: string,
  amount: number,
  recipientAddress: string,
  chainId: number,
): EvmTransferTx {
  const upper = tokenSymbol.toUpperCase();

  // Native ETH transfer
  if (upper === 'ETH') {
    // Clamp to 18 decimal places — JS floats from USD÷price can produce
    // 19+ significant digits which causes ethers.parseEther to throw NUMERIC_FAULT.
    const weiValue = ethers.parseEther(amount.toFixed(18));
    return {
      to: recipientAddress,
      data: '0x',
      value: '0x' + weiValue.toString(16),
      chainId,
    };
  }

  // ERC-20 transfer
  const token = getToken(upper);
  if (!token) throw new Error(`Unknown EVM token: ${tokenSymbol}`);

  const iface = new ethers.Interface(ERC20_TRANSFER_ABI);
  // Clamp to the token's decimal precision to avoid NUMERIC_FAULT
  const rawAmount = ethers.parseUnits(amount.toFixed(token.decimals), token.decimals);
  const data = iface.encodeFunctionData('transfer', [recipientAddress, rawAmount]);

  return {
    to: token.address,
    data,
    value: '0x0',
    chainId,
  };
}

// ─── Solana Transfers ──────────────────────────────────────────────────────

/**
 * Build a Solana transfer transaction (SOL or SPL token).
 * Returns a base64-encoded serialized transaction for Phantom to sign.
 */
export async function buildSolanaTransfer(
  tokenSymbol: string,
  amount: number,
  senderPublicKey: string,
  recipientAddress: string,
): Promise<{ serializedTransaction: string }> {
  const {
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
  } = await import('@solana/web3.js');

  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const sender = new PublicKey(senderPublicKey);
  const recipient = new PublicKey(recipientAddress);
  const upper = tokenSymbol.toUpperCase();

  let tx: InstanceType<typeof Transaction>;

  if (upper === 'SOL') {
    // Native SOL transfer
    const lamports = Math.round(amount * LAMPORTS_PER_SOL);
    tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: recipient,
        lamports,
      }),
    );
  } else {
    // SPL token transfer
    const mintInfo = SOLANA_MINTS[upper];
    if (!mintInfo) throw new Error(`Unknown Solana token: ${tokenSymbol}`);

    const { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, getAccount } = await import('@solana/spl-token');
    const mint = new PublicKey(mintInfo.mint);
    const decimals = mintInfo.decimals;
    const rawAmount = BigInt(Math.round(amount * 10 ** decimals));

    const senderAta = await getAssociatedTokenAddress(mint, sender);
    const recipientAta = await getAssociatedTokenAddress(mint, recipient);

    tx = new Transaction();

    // Create recipient's ATA if it doesn't exist
    try {
      await getAccount(connection, recipientAta);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(sender, recipientAta, recipient, mint),
      );
    }

    tx.add(
      createTransferInstruction(senderAta, recipientAta, sender, rawAmount),
    );
  }

  // Set recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = sender;

  // Serialize (unsigned — Phantom will sign)
  const serialized = tx.serialize({ requireAllSignatures: false });
  const base64 = Buffer.from(serialized).toString('base64');

  return { serializedTransaction: base64 };
}

// ─── Helper: detect if a token is Solana-native ────────────────────────────

export function isSolanaTransfer(tokenSymbol: string): boolean {
  return SOLANA_TOKENS.has(tokenSymbol.toUpperCase());
}
