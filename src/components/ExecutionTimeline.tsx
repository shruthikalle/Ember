import type { AgentAction } from '../types';

interface ExecutionTimelineProps {
  actions: AgentAction[];
}

export default function ExecutionTimeline({ actions }: ExecutionTimelineProps) {
  const getStatusColor = (status: AgentAction['status']) => {
    switch (status) {
      case 'pending':
        return 'text-gray-400 border-gray-400';
      case 'executing':
        return 'text-trading-accent-blue border-trading-accent-blue animate-pulse';
      case 'completed':
        return 'text-trading-accent border-trading-accent';
      case 'failed':
        return 'text-red-400 border-red-400';
    }
  };

  const getTypeIcon = (type: AgentAction['type']) => {
    switch (type) {
      case 'market_data':
        return '📊';
      case 'compute':
        return '🧮';
      case 'analysis':
        return '🔍';
      case 'trade_execution':
        return '💱';
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="panel">
      <div className="panel-header">Execution Timeline</div>
      
      {actions.length === 0 ? (
        <div className="text-center py-12 text-trading-text-dim">
          <p className="text-sm">No actions yet. Submit a prompt to begin execution.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {actions.map((action, index) => (
            <div
              key={action.id}
              className={`border-l-2 pl-4 pb-4 ${
                index === actions.length - 1 ? 'border-transparent' : getStatusColor(action.status)
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{getTypeIcon(action.type)}</span>
                  <div>
                    <h3 className="text-sm font-semibold text-trading-text">
                      {action.description}
                    </h3>
                    <p className="text-xs text-trading-text-dim mt-1">
                      {formatTime(action.timestamp)}
                    </p>
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-1 rounded border ${getStatusColor(action.status)}`}
                >
                  {action.status}
                </span>
              </div>

              {action.payment && (
                <div className="mt-2 p-3 bg-trading-bg rounded border border-trading-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-trading-text-dim">x402 Payment</span>
                    <span className="text-sm font-semibold text-trading-accent">
                      {action.payment.amount.toFixed(2)} x402
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-trading-text-dim">Recipient:</span>
                      <span className="font-mono text-trading-text">
                        {action.payment.recipient.slice(0, 12)}...
                      </span>
                    </div>
                    {action.payment.status === 'confirmed' && (
                      <div className="flex justify-between text-xs">
                        <span className="text-trading-text-dim">Tx Hash:</span>
                        <span className="font-mono text-trading-accent-blue">
                          {action.payment.transactionHash.slice(0, 10)}...
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          action.payment.status === 'confirmed'
                            ? 'bg-trading-accent'
                            : action.payment.status === 'pending'
                            ? 'bg-yellow-400 animate-pulse'
                            : 'bg-red-400'
                        }`}
                      ></div>
                      <span className="text-xs text-trading-text-dim capitalize">
                        {action.payment.status}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {action.result && (
                <div className="mt-2 p-3 bg-green-900/10 border border-green-400/20 rounded">
                  <p className="text-xs text-green-400">{action.result}</p>
                </div>
              )}

              {action.error && (
                <div className="mt-2 p-3 bg-red-900/10 border border-red-400/20 rounded">
                  <p className="text-xs text-red-400">{action.error}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
