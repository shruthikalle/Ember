'use client';

import { useEffect, useState, useRef } from 'react';

interface StreamMessage {
  type: 'connected' | 'markets' | 'update' | 'error';
  quicknode?: boolean;
  data?: any;
  message?: string;
  timestamp?: number;
}

export default function HyperCoreLiveFeed() {
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quicknodeEnabled, setQuicknodeEnabled] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setStatus('connecting');
    setError(null);

    const eventSource = new EventSource('/api/perps/stream');
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setStatus('connected');
      setError(null);
    };

    eventSource.onmessage = (event) => {
      try {
        const msg: StreamMessage = JSON.parse(event.data);
        
        if (msg.type === 'connected') {
          setQuicknodeEnabled(msg.quicknode || false);
        } else if (msg.type === 'update') {
          setLastUpdate(msg.timestamp || Date.now());
        } else if (msg.type === 'error') {
          setError(msg.message || 'Unknown error');
        }
      } catch (err) {
        console.error('[HyperCore] Failed to parse message:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('[HyperCore] SSE error:', err);
      setStatus('disconnected');
      setError('Connection lost');
      eventSource.close();
    };

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, []);

  const statusColor = 
    status === 'connected' ? 'bg-green-500' :
    status === 'connecting' ? 'bg-yellow-500' :
    'bg-red-500';

  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${statusColor} animate-pulse`} />
        <span className="text-trading-text-dim">
          {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting...' : 'Offline'}
        </span>
      </div>
      {quicknodeEnabled && (
        <span className="text-[#8B5CF6] font-medium">QuickNode</span>
      )}
      {lastUpdate && (
        <span className="text-trading-text-dim">
          {new Date(lastUpdate).toLocaleTimeString()}
        </span>
      )}
      {error && (
        <span className="text-red-400" title={error}>⚠️</span>
      )}
    </div>
  );
}
