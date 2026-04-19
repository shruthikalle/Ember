import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Minimal JSON-RPC stub for Hyperliquid's signing chain (chainId 1337).
 *
 * Hyperliquid's EIP-712 domain hardcodes chainId 1337, but no public EVM chain
 * exists with that ID.  MetaMask enforces that the EIP-712 domain chainId
 * matches the active network, so we must temporarily switch MetaMask to chain
 * 1337 when signing Hyperliquid orders.
 *
 * This route handles the bare minimum JSON-RPC methods MetaMask queries when
 * adding / validating / switching to a custom chain.  No real blockchain sits
 * behind it — it exists solely so MetaMask accepts chain 1337 as valid.
 */

const CHAIN_ID_HEX = '0x539'; // 1337

const STATIC: Record<string, unknown> = {
  eth_chainId: CHAIN_ID_HEX,
  net_version: '1337',
  eth_blockNumber: '0x1',
  eth_gasPrice: '0x0',
  eth_maxPriorityFeePerGas: '0x0',
  eth_feeHistory: { oldestBlock: '0x1', baseFeePerGas: ['0x0'], gasUsedRatio: [0] },
  eth_getBalance: '0x0',
  eth_getCode: '0x',
  eth_call: '0x',
  eth_estimateGas: '0x5208',
  eth_getTransactionCount: '0x0',
  eth_getBlockByNumber: {
    number: '0x1',
    hash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    timestamp: '0x0',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    transactions: [],
  },
  eth_getBlockByHash: null,
  eth_getLogs: [],
  eth_subscribe: '0x1',
  eth_unsubscribe: true,
  web3_clientVersion: 'HyperliquidSigningStub/1.0',
};

/** Shared CORS headers — MetaMask extension may fetch from its service-worker. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonRes(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Handle batch requests
    if (Array.isArray(body)) {
      const results = body.map((item: { method: string; id: unknown }) => ({
        jsonrpc: '2.0' as const,
        id: item.id ?? null,
        result: STATIC[item.method] ?? null,
      }));
      return jsonRes(results);
    }

    const { method, id } = body;
    return jsonRes({
      jsonrpc: '2.0',
      id: id ?? null,
      result: STATIC[method] ?? null,
    });
  } catch {
    return jsonRes(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      400,
    );
  }
}

/** MetaMask may probe the RPC with a GET / OPTIONS before trusting it. */
export async function GET() {
  return jsonRes({ status: 'ok', chainId: 1337 });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
