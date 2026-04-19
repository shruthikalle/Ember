/**
 * Kite MCP Client
 * 
 * Connects to Kite MCP server via Server-Sent Events (SSE)
 * Provides tool wrappers for wallet operations
 * 
 * TODO: Replace placeholder OAuth flow with real Kite Passport endpoints
 * TODO: Update MCP_SERVER_URL when Kite provides production endpoint
 */

import { ethers } from 'ethers';
import type { GetPayerAddrResponse, ApprovePaymentResponse, SignTransactionResponse, SignTypedDataResponse } from '../types';

export interface KiteMcpClient {
  connect(): Promise<void>;
  callTool(toolName: string, args: unknown): Promise<unknown>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  setOAuthToken?(token: string): void;
}

interface McpToolCall {
  name: string;
  arguments: unknown;
}

interface McpToolResult {
  content: unknown;
  isError?: boolean;
}

/**
 * Real MCP Client implementation (SSE transport)
 */
class RealKiteMcpClient implements KiteMcpClient {
  private eventSource: EventSource | null = null;
  private serverUrl: string;
  private connected: boolean = false;
  private oauthToken: string | null = null;
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();

  constructor(serverUrl: string, oauthToken?: string) {
    this.serverUrl = serverUrl;
    this.oauthToken = oauthToken || null;
  }

  setOAuthToken(token: string): void {
    this.oauthToken = token;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        // Connect to MCP server via SSE
        // TODO: Implement actual SSE connection to MCP server
        // For now, this is a placeholder
        this.eventSource = new EventSource(`${this.serverUrl}/events`);
        
        this.eventSource.onopen = () => {
          this.connected = true;
          resolve();
        };

        this.eventSource.onerror = (error) => {
          this.connected = false;
          reject(new Error(`MCP connection failed: ${error}`));
        };

        this.eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.requestId && this.pendingRequests.has(data.requestId)) {
              const { resolve } = this.pendingRequests.get(data.requestId)!;
              this.pendingRequests.delete(data.requestId);
              resolve(data.result);
            }
          } catch (error) {
            console.error('Error parsing MCP message:', error);
          }
        };
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Failed to connect to MCP server'));
      }
    });
  }

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    if (!this.connected || !this.eventSource) {
      throw new Error('MCP client not connected');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      // Send tool call via fetch (MCP over HTTP)
      // Include OAuth token if available
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (this.oauthToken) {
        headers['Authorization'] = `Bearer ${this.oauthToken}`;
      }

      fetch(`${this.serverUrl}/tools/${toolName}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requestId,
          arguments: args,
        }),
      })
        .then(response => response.json())
        .then(data => {
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data.result);
          }
        })
        .catch(error => {
          reject(error);
        });
    });
  }

  async disconnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Mock MCP Client (DEV ONLY)
 * Uses ephemeral ethers wallet for development
 */
class MockKiteMcpClient implements KiteMcpClient {
  private wallet: ethers.HDNodeWallet;
  private connected: boolean = false;

  constructor() {
    // Generate ephemeral wallet for dev
    // DEV ONLY - clearly labeled
    this.wallet = ethers.Wallet.createRandom() as ethers.HDNodeWallet;
    console.warn('⚠️  DEV ONLY: Using mock MCP client with ephemeral wallet');
    console.warn(`⚠️  Wallet address: ${this.wallet.address}`);
  }

  async connect(): Promise<void> {
    this.connected = true;
    console.log('Mock MCP client connected (DEV ONLY)');
  }

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    if (!this.connected) {
      throw new Error('Mock MCP client not connected');
    }

    switch (toolName) {
      case 'get_payer_addr':
        return {
          payer_addr: this.wallet.address,
        } as GetPayerAddrResponse;

      case 'approve_payment':
        // Mock payment approval - just return a mock token
        return {
          x_payment: `mock_payment_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        } as ApprovePaymentResponse;

      case 'sign_transaction':
        // Sign transaction using mock wallet
        const txRequest = args as ethers.TransactionRequest;
        const provider = new ethers.JsonRpcProvider(process.env.NEXT_PUBLIC_RPC_URL || process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com');
        const connectedWallet = this.wallet.connect(provider);
        const tx = await connectedWallet.signTransaction(txRequest);
        return {
          signed_transaction: tx,
        } as SignTransactionResponse;

      case 'sign_typed_data':
        // Sign typed data using mock wallet
        const typedData = args as { domain: unknown; types: unknown; value: unknown };
        const signature = await this.wallet.signTypedData(
          typedData.domain as ethers.TypedDataDomain,
          typedData.types as Record<string, ethers.TypedDataField[]>,
          typedData.value as Record<string, unknown>
        );
        return {
          signature,
        } as SignTypedDataResponse;

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Create MCP client instance
 */
export function createKiteMcpClient(oauthToken?: string): KiteMcpClient {
  const mockMode = process.env.NEXT_PUBLIC_MOCK_MCP === 'true';
  const serverUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || 'http://localhost:8080/mcp';

  if (mockMode) {
    return new MockKiteMcpClient();
  }

  return new RealKiteMcpClient(serverUrl, oauthToken);
}

/**
 * Tool wrapper: get_payer_addr
 */
export async function getPayerAddr(client: KiteMcpClient): Promise<string> {
  const result = await client.callTool('get_payer_addr', {}) as GetPayerAddrResponse;
  return result.payer_addr;
}

/**
 * Tool wrapper: approve_payment
 */
export async function approvePayment(
  client: KiteMcpClient,
  payerAddr: string,
  payeeAddr: string,
  amount: string,
  tokenType: string
): Promise<string> {
  const result = await client.callTool('approve_payment', {
    payer_addr: payerAddr,
    payee_addr: payeeAddr,
    amount,
    token_type: tokenType,
  }) as ApprovePaymentResponse;
  return result.x_payment;
}

/**
 * Tool wrapper: sign_transaction
 */
export async function signTransaction(
  client: KiteMcpClient,
  txRequest: ethers.TransactionRequest
): Promise<string> {
  const result = await client.callTool('sign_transaction', txRequest) as SignTransactionResponse;
  return result.signed_transaction;
}

/**
 * Tool wrapper: sign_typed_data
 */
export async function signTypedData(
  client: KiteMcpClient,
  domain: ethers.TypedDataDomain,
  types: Record<string, unknown>,
  value: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool('sign_typed_data', {
    domain,
    types,
    value,
  }) as SignTypedDataResponse;
  return result.signature;
}
