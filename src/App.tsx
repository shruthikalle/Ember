import AgentIdentityPanel from './components/AgentIdentityPanel';
import PromptInput from './components/PromptInput';
import ExecutionTimeline from './components/ExecutionTimeline';
import SettlementPanel from './components/SettlementPanel';
import WalletConnect from './components/WalletConnect';
import { useAgentExecution } from './hooks/useAgentExecution';

function App() {
  const { identity, session, settlement, executePrompt, resetExecution } = useAgentExecution();

  const isExecuting = session?.status === 'executing';
  const isCompleted = session?.status === 'completed';

  return (
    <div className="min-h-screen bg-trading-bg">
      {/* Header */}
      <header className="border-b border-trading-border bg-trading-surface">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-trading-text">
                Kite AI Agent Dashboard
              </h1>
              <p className="text-sm text-trading-text-dim mt-1">
                Autonomous Financial Agent • x402 Payment Protocol
              </p>
            </div>
            <div className="flex items-center gap-4">
              <WalletConnect />
            {session && (
              <button
                onClick={resetExecution}
                className="px-4 py-2 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors text-sm"
                disabled={isExecuting}
              >
                {isExecuting ? 'Executing...' : 'New Session'}
              </button>
            )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column */}
          <div className="lg:col-span-1 space-y-6">
            <AgentIdentityPanel identity={identity} />
            <PromptInput
              onSubmit={executePrompt}
              disabled={isExecuting || isCompleted}
              currentPrompt={session?.prompt}
            />
          </div>

          {/* Right Column */}
          <div className="lg:col-span-2 space-y-6">
            <ExecutionTimeline actions={session?.actions || []} />
            <SettlementPanel settlement={settlement} />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-trading-border bg-trading-surface mt-12">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between text-sm text-trading-text-dim">
          
            <div className="flex items-center gap-4">
              <a href="#" className="hover:text-trading-accent transition-colors">
                Documentation
              </a>
              <a href="#" className="hover:text-trading-accent transition-colors">
                GitHub
              </a>
              <a href="https://kite.ai" target="_blank" rel="noopener noreferrer" className="hover:text-trading-accent transition-colors">
                Kite AI
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
