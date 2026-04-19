import type { Settlement } from '../types';

interface SettlementPanelProps {
  settlement?: Settlement;
}

export default function SettlementPanel({ settlement }: SettlementPanelProps) {
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="panel">
      <div className="panel-header">Settlement & Proof</div>
      
      {!settlement ? (
        <div className="text-center py-12 text-trading-text-dim">
          <p className="text-sm">Settlement will appear after execution completes</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="p-4 bg-trading-accent/10 border border-trading-accent/30 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <svg
                className="w-5 h-5 text-trading-accent"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-sm font-semibold text-trading-accent">
                Settlement Confirmed
              </span>
            </div>
            <p className="text-xs text-trading-text-dim">
              All actions settled on Kite AI blockchain
            </p>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">
              Settlement Transaction
            </label>
            <p className="text-sm font-mono text-trading-text mt-1 break-all">
              {settlement.transactionHash}
            </p>
            <a
              href={`https://testnet.kite.ai/tx/${settlement.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-trading-accent-blue hover:underline mt-1 inline-block"
            >
              View on Kite Explorer →
            </a>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">
              Execution Attestation
            </label>
            <p className="text-sm font-mono text-trading-text mt-1 break-all">
              {settlement.attestation}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 pt-4 border-t border-trading-border">
            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">
                Actions
              </label>
              <p className="text-lg font-semibold text-trading-text mt-1">
                {settlement.actions.length}
              </p>
            </div>

            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">
                Total Cost
              </label>
              <p className="text-lg font-semibold text-trading-accent mt-1">
                {settlement.totalAmount.toFixed(2)} x402
              </p>
            </div>

            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">
                Settled At
              </label>
              <p className="text-sm text-trading-text mt-1">
                {formatTime(settlement.timestamp)}
              </p>
            </div>
          </div>

          <div className="p-3 bg-trading-bg rounded border border-trading-border">
            <p className="text-xs text-trading-text-dim">
              <span className="text-trading-accent font-semibold">Verifiable Proof:</span> This 
              settlement is cryptographically verifiable on Kite AI. All x402 payments are 
              atomically settled with near-instant finality.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
