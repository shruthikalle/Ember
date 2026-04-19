export interface AgentIdentity {
  did: string;
  walletAddress: string;
  network: string;
  balance: number;
  status: 'idle' | 'executing' | 'completed' | 'failed';
}

export interface X402Payment {
  id: string;
  amount: number;
  recipient: string;
  transactionHash: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'failed';
  action: string;
}

export interface AgentAction {
  id: string;
  type: 'market_data' | 'compute' | 'trade_execution' | 'analysis';
  description: string;
  timestamp: number;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  payment?: X402Payment;
  result?: string;
  error?: string;
}

export interface ExecutionSession {
  id: string;
  prompt: string;
  status: 'idle' | 'executing' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  actions: AgentAction[];
  totalCost: number;
}

export interface Settlement {
  transactionHash: string;
  timestamp: number;
  actions: string[];
  totalAmount: number;
  attestation: string;
}
