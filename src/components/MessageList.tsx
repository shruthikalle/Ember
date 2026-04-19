'use client';

import { ChatMessage } from '@/src/lib/types';
import { formatAddress } from '@/src/utils/format';

interface MessageListProps {
  messages: ChatMessage[];
}

export default function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-trading-text-dim">
        <p>Start by typing a trading command like "Buy $100 ETH"</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 overflow-y-auto flex-1">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[80%] rounded-lg p-4 ${
              message.role === 'user'
                ? 'bg-trading-accent text-black'
                : 'bg-trading-surface border border-trading-border text-trading-text'
            }`}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
            
            {message.tradeIntent && (
              <div className="mt-2 pt-2 border-t border-current/20 text-xs">
                <p className="font-semibold mb-1">Trade Intent:</p>
                <p>
                  {message.tradeIntent.side} {message.tradeIntent.amountUsd ? `$${message.tradeIntent.amountUsd}` : `${message.tradeIntent.amountToken} ${message.tradeIntent.tokenInSymbol}`} → {message.tradeIntent.tokenOutSymbol}
                </p>
              </div>
            )}

            {message.quote && (
              <div className="mt-2 pt-2 border-t border-current/20 text-xs">
                <p className="font-semibold mb-1">Quote:</p>
                <p>Out: {message.quote.amountOutFormatted} (min: {message.quote.minAmountOutFormatted})</p>
              </div>
            )}

            {message.txHash && (
              <div className="mt-2 pt-2 border-t border-current/20">
                <a
                  href={`https://basescan.org/tx/${message.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-trading-accent-blue hover:underline"
                >
                  View on Basescan: {formatAddress(message.txHash)}
                </a>
              </div>
            )}

            <p className="text-xs opacity-70 mt-2">
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
