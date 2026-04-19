/**
 * Polymarket CLOB Client (server-side, SDK-based)
 *
 * Uses the official @polymarket/clob-client SDK to execute trades.
 *
 * Environment variables (reads POLY_* names from SECRETS.md):
 *   POLY_PRIVATE_KEY     — EOA private key (MetaMask export)
 *   POLY_ADDRESS         — Polymarket proxy wallet address (from Polymarket UI)
 *   POLY_API_KEY         — CLOB API key   (manual, from Polymarket Settings)
 *   POLY_SECRET          — CLOB API secret
 *   POLY_PASSPHRASE      — CLOB API passphrase
 *   POLYGON_RPC_URL      — (optional) Polygon RPC endpoint
 *
 * If POLY_ADDRESS differs from signer address → signatureType 1 (POLY_PROXY)
 * If they are the same or POLY_ADDRESS not set → signatureType 0 (EOA)
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
// Use ethers v5 Wallet — the @polymarket/clob-client SDK calls _signTypedData (v5 API)
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';

// ─── Singleton Client ───────────────────────────────────────────────────────

let _client: ClobClient | null = null;
let _walletAddress: string | null = null;
let _funderAddress: string | null = null;

async function getClient(): Promise<ClobClient> {
  if (_client) return _client;

  // Read private key (POLY_PRIVATE_KEY preferred, AGENT_PRIVATE_KEY as fallback)
  const privateKey = process.env.POLY_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY ;
  if (!privateKey) {
    throw new Error(
      'POLY_PRIVATE_KEY not set. Export your MetaMask private key and add it to .env as POLY_PRIVATE_KEY=0x...',
    );
  }

  const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const provider = new JsonRpcProvider(rpcUrl);
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const signer = new Wallet(pk, provider);
  _walletAddress = signer.address;

  // Read proxy wallet address (POLY_ADDRESS preferred, POLYMARKET_FUNDER_ADDRESS fallback)
  const proxyAddr = process.env.POLY_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || '';
  const hasProxy = proxyAddr && proxyAddr.toLowerCase() !== _walletAddress.toLowerCase();
  _funderAddress = hasProxy ? proxyAddr : _walletAddress;

  // Determine signature type:
  // 0 (EOA)         = signer IS the wallet that holds funds
  // 2 (GNOSIS_SAFE) = browser-created Polymarket accounts use a Gnosis Safe proxy
  const sigType = hasProxy ? 2 : 0;

  console.log('[PolyClient] Config:', {
    signer: _walletAddress,
    funder: _funderAddress,
    hasProxy,
    signatureType: sigType,
  });

  // Read API credentials (POLY_* preferred, POLYMARKET_CLOB_* fallback)
  const envKey = process.env.POLY_API_KEY || process.env.POLYMARKET_CLOB_API_KEY;
  const envSecret = process.env.POLY_SECRET || process.env.POLYMARKET_CLOB_SECRET;
  const envPassphrase = process.env.POLY_PASSPHRASE || process.env.POLYMARKET_CLOB_PASSPHRASE;

  let creds: { key: string; secret: string; passphrase: string };

  if (envKey && envSecret && envPassphrase) {
    creds = { key: envKey, secret: envSecret, passphrase: envPassphrase };
    console.log('[PolyClient] Using manual API credentials from env');
  } else {
    // Derive API creds from signer
    console.log('[PolyClient] No API creds in env — deriving from signer...');
    const tempClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      signer,
      undefined,
      sigType,
      hasProxy ? _funderAddress : undefined,
    );
    creds = await tempClient.createOrDeriveApiKey();
    console.log('[PolyClient] Derived API key:', creds.key);
  }

  _client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer,
    creds,
    sigType,
    hasProxy ? _funderAddress : undefined,
  );

  console.log('[PolyClient] Initialized — signer:', _walletAddress, 'funder:', _funderAddress, 'sigType:', sigType);
  return _client;
}

/** Reset singleton (useful for re-init after env change) */
export function resetClient() {
  _client = null;
  _walletAddress = null;
  _funderAddress = null;
}

export function getPolyWalletAddress(): string {
  return _funderAddress || _walletAddress || '';
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface TradeResult {
  success: boolean;
  orderID?: string;
  transactIDs?: string[];
  status?: string;
  error?: string;
  details?: any;
}

/**
 * Execute a market order (FOK) — immediately fill or kill.
 * Falls back to GTC limit if FOK can't fill (thin book).
 *
 * BUY: `amount` = dollars to spend
 * SELL: `amount` = number of shares to sell
 */
export async function executeMarketOrder(params: {
  tokenID: string;
  amount: number;
  side: 'BUY' | 'SELL';
  price?: number;
}): Promise<TradeResult> {
  const client = await getClient();
  const { tokenID, amount, side, price } = params;

  try {
    const [tickSize, negRisk] = await Promise.all([
      client.getTickSize(tokenID),
      client.getNegRisk(tokenID),
    ]);

    console.log('[PolyClient] Market order:', {
      tokenID: tokenID.slice(0, 20) + '...',
      amount,
      side,
      price,
      tickSize,
      negRisk,
    });

    // Try FOK first (immediate fill)
    const result = await client.createAndPostMarketOrder(
      {
        tokenID,
        amount,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        price,
      },
      { tickSize, negRisk },
      OrderType.FOK,
    );

    console.log('[PolyClient] FOK result:', JSON.stringify(result));

    // Check if the SDK returned an error object instead of throwing
    if (result?.error || result?.status === 400 || result?.status === 401) {
      const errMsg = result.error || `CLOB error (${result.status})`;

      // If FOK failed because not enough liquidity, try GTC limit
      if (errMsg.includes('fully filled') && price) {
        console.log('[PolyClient] FOK failed, trying GTC limit...');
        return executeLimitOrder({
          tokenID,
          price,
          size: parseFloat((amount / price).toFixed(1)),
          side,
        });
      }

      return { success: false, error: errMsg };
    }

    return {
      success: true,
      orderID: result?.orderID,
      transactIDs: result?.transactIDs || [],
      status: result?.status || 'matched',
      details: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PolyClient] Market order error:', msg);
    return { success: false, error: msg };
  }
}

/**
 * Execute a limit order (GTC) — rests on the book until filled.
 */
export async function executeLimitOrder(params: {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
}): Promise<TradeResult> {
  const client = await getClient();
  const { tokenID, price, size, side } = params;

  try {
    const [tickSize, negRisk] = await Promise.all([
      client.getTickSize(tokenID),
      client.getNegRisk(tokenID),
    ]);

    console.log('[PolyClient] Limit order:', {
      tokenID: tokenID.slice(0, 20) + '...',
      price,
      size,
      side,
      tickSize,
      negRisk,
    });

    const result = await client.createAndPostOrder(
      {
        tokenID,
        price,
        size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
      },
      { tickSize, negRisk },
      OrderType.GTC,
    );

    console.log('[PolyClient] GTC result:', JSON.stringify(result));

    if (result?.error || result?.status === 400 || result?.status === 401) {
      return { success: false, error: result.error || `CLOB error (${result.status})` };
    }

    return {
      success: true,
      orderID: result?.orderID,
      transactIDs: result?.transactIDs || [],
      status: result?.status || 'live',
      details: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[PolyClient] Limit order error:', msg);
    return { success: false, error: msg };
  }
}

/**
 * Get best available price for a side.
 */
export async function getPrice(tokenID: string, side: 'BUY' | 'SELL'): Promise<number | null> {
  try {
    const client = await getClient();
    const result = await client.getPrice(tokenID, side);
    // SDK shape varies across versions: sometimes `{ price: "0.17" }`, sometimes
    // a bare number or string. Normalize everything.
    if (result == null) return null;
    if (typeof result === 'number') return Number.isFinite(result) ? result : null;
    if (typeof result === 'string') {
      const p = parseFloat(result);
      return Number.isFinite(p) ? p : null;
    }
    const priceField = (result as any).price;
    if (priceField == null) return null;
    const p = typeof priceField === 'number' ? priceField : parseFloat(String(priceField));
    return Number.isFinite(p) ? p : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[PolyClient] getPrice failed:', msg.slice(0, 200));
    return null;
  }
}

/**
 * Get order book for a token.
 */
export async function getOrderBook(tokenID: string) {
  const client = await getClient();
  return client.getOrderBook(tokenID);
}
