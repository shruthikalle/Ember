'use client';

import { TradeIntent, Quote, GuardrailResult } from '@/src/lib/types';
import { formatAddress } from '@/src/utils/format';
import { BASE_CHAIN_ID } from '@/src/lib/tokens';

interface TradeReviewModalProps {
  intent: TradeIntent;
  quote: Quote;
  guardrails: GuardrailResult;
  walletAddress: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function TradeReviewModal({
  intent,
  quote,
  guardrails,
  walletAddress,
  onConfirm,
  onCancel,
  loading = false,
}: TradeReviewModalProps) {
  const slippagePercent = (quote.slippageBps / 100).toFixed(2);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-trading-surface border border-trading-border rounded-lg max-w-2xl w-full p-6 space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-trading-text mb-2">Review Trade</h2>
          <p className="text-sm text-trading-text-dim">Please review the trade details before confirming</p>
        </div>

        {/* Trade Details */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">From Token</label>
              <p className="text-lg font-semibold text-trading-text mt-1">{intent.tokenInSymbol}</p>
              {intent.tokenInSymbol === 'ETH' && (
                <p className="text-xs text-trading-text-dim mt-1">
                  (Native ETH - will be wrapped to WETH automatically by Uniswap router)
                </p>
              )}
            </div>
            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">To Token</label>
              <p className="text-lg font-semibold text-trading-text mt-1">{intent.tokenOutSymbol}</p>
            </div>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">Amount In</label>
            <p className="text-xl font-semibold text-trading-accent mt-1">
              {intent.amountUsd ? `$${intent.amountUsd.toFixed(2)}` : `${quote.amountInFormatted} ${intent.tokenInSymbol}`}
            </p>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">Estimated Amount Out</label>
            <p className="text-xl font-semibold text-trading-text mt-1">
              {quote.amountOutFormatted} {intent.tokenOutSymbol}
            </p>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">Minimum Amount Out (after slippage)</label>
            <p className="text-lg font-semibold text-trading-accent-blue mt-1">
              {quote.minAmountOutFormatted} {intent.tokenOutSymbol}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">Slippage</label>
              <p className="text-sm text-trading-text mt-1">{slippagePercent}%</p>
            </div>
            <div>
              <label className="text-xs text-trading-text-dim uppercase tracking-wide">Chain</label>
              <p className="text-sm text-trading-text mt-1">Base ({BASE_CHAIN_ID})</p>
            </div>
          </div>

          <div>
            <label className="text-xs text-trading-text-dim uppercase tracking-wide">Recipient</label>
            <p className="text-sm font-mono text-trading-text mt-1 break-all">{formatAddress(walletAddress)}</p>
          </div>
        </div>

        {/* Guardrail Warnings/Errors */}
        {guardrails.warnings && guardrails.warnings.length > 0 && (
          <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <p className="text-xs font-semibold text-yellow-400 uppercase mb-1">Warnings</p>
            <ul className="text-sm text-trading-text space-y-1">
              {guardrails.warnings.map((warning, i) => (
                <li key={i}>• {warning}</li>
              ))}
            </ul>
          </div>
        )}

        {guardrails.errors && guardrails.errors.length > 0 && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-xs font-semibold text-red-400 uppercase mb-1">Errors</p>
            <ul className="text-sm text-trading-text space-y-1">
              {guardrails.errors.map((error, i) => (
                <li key={i}>• {error}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t border-trading-border">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 px-4 py-3 bg-trading-border hover:bg-trading-border/80 text-trading-text rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || (guardrails.errors && guardrails.errors.length > 0)}
            className="flex-1 px-4 py-3 bg-trading-accent hover:bg-trading-accent/80 text-black rounded-lg transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Signing...' : 'Confirm & Sign'}
          </button>
        </div>
      </div>
    </div>
  );
}
