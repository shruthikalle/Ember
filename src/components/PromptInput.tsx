import { useState } from 'react';

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  disabled: boolean;
  currentPrompt?: string;
}

export default function PromptInput({ onSubmit, disabled, currentPrompt }: PromptInputProps) {
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && !disabled) {
      onSubmit(prompt);
    }
  };

  const displayValue = disabled && currentPrompt ? currentPrompt : prompt;

  return (
    <div className="panel">
      <div className="panel-header">Agent Prompt</div>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <textarea
            value={displayValue}
            onChange={(e) => !disabled && setPrompt(e.target.value)}
            placeholder="Enter your trading instruction (e.g., 'Analyze ETH market and execute a buy if conditions are favorable')"
            className="input-field resize-none h-24"
            disabled={disabled}
            readOnly={disabled}
          />
          {disabled && (
            <p className="text-xs text-trading-text-dim mt-2 flex items-center gap-2">
              <span className="w-2 h-2 bg-trading-accent rounded-full animate-pulse"></span>
              Prompt locked during execution
            </p>
          )}
        </div>

        {!disabled && (
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={!prompt.trim()}
          >
            Execute Agent
          </button>
        )}
      </form>

      <div className="mt-4 p-3 bg-trading-bg rounded border border-trading-border">
        <p className="text-xs text-trading-text-dim">
          <span className="text-trading-accent font-semibold">Note:</span> The agent will autonomously 
          execute trades and pay for services using x402 micropayments on Kite AI. No manual approval required.
        </p>
      </div>
    </div>
  );
}
