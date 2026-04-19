import type { AgentIdentity } from '../types';

interface AgentIdentityPanelProps {
  identity: AgentIdentity;
}

export default function AgentIdentityPanel({ identity }: AgentIdentityPanelProps) {
  const statusColors = {
    idle: 'text-gray-400',
    executing: 'text-trading-accent animate-pulse',
    completed: 'text-green-400',
    failed: 'text-red-400',
  };

  const statusDots = {
    idle: 'bg-gray-400',
    executing: 'bg-trading-accent animate-pulse',
    completed: 'bg-green-400',
    failed: 'bg-red-400',
  };

  return (
    <div className="panel">
      <div className="panel-header flex items-center justify-between">
        <span>Agent Identity</span>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${statusDots[identity.status]}`}></div>
          <span className={`text-xs capitalize ${statusColors[identity.status]}`}>
            {identity.status}
          </span>
        </div>
      </div>
      
      <div className="space-y-4">
        <div>
          <label className="text-xs text-trading-text-dim uppercase tracking-wide">DID</label>
          <p className="text-sm font-mono text-trading-text mt-1 break-all">
            {identity.did}
          </p>
        </div>

        <div>
          <label className="text-xs text-trading-text-dim uppercase tracking-wide">Wallet Address</label>
          <p className="text-sm font-mono text-trading-text mt-1">
            {identity.walletAddress}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">Network</label>
            <p className="text-sm text-trading-text mt-1 flex items-center gap-2">
              <span className="w-2 h-2 bg-trading-accent rounded-full"></span>
              {identity.network}
            </p>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">Balance (x402)</label>
            <p className="text-sm text-trading-accent font-semibold mt-1">
              {identity.balance.toFixed(2)} x402
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
