/**
 * GET /api/perps/stream
 *
 * Server-Sent Events (SSE) stream for real-time Hyperliquid market data
 * via QuickNode HyperCore. Streams market updates, trades, and order book
 * changes for subscribed markets.
 */

import { NextRequest } from 'next/server';
import { qnInfo, isQuickNodeEnabled } from '@/src/lib/quicknode-stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  let intervalId: NodeJS.Timeout | null = null;
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        // Don't try to send if the stream is already closed
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch (err) {
          // Controller might be closed - mark as closed and cleanup
          isClosed = true;
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          console.warn('[SSE Stream] Controller closed, stopping sends');
        }
      };

      const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        try {
          controller.close();
        } catch (err) {
          // Controller might already be closed
        }
      };

      // Send initial connection message
      send(JSON.stringify({ type: 'connected', quicknode: isQuickNodeEnabled() }));

      // Get market list
      try {
        const markets = await qnInfo({ type: 'metaAndAssetCtxs' });
        send(JSON.stringify({ type: 'markets', data: markets }));
      } catch (err) {
        send(JSON.stringify({ type: 'error', message: String(err) }));
        cleanup();
        return;
      }

      // Poll for updates every 2 seconds
      intervalId = setInterval(async () => {
        // Check if closed before attempting to fetch
        if (isClosed) {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }

        try {
          // Fetch latest market data
          const meta = await qnInfo({ type: 'metaAndAssetCtxs' });
          send(JSON.stringify({ type: 'update', data: meta, timestamp: Date.now() }));
        } catch (err) {
          // Only send error if stream is still open
          if (!isClosed) {
            send(JSON.stringify({ type: 'error', message: String(err) }));
          }
        }
      }, 2000);

      // Cleanup on client disconnect
      req.signal.addEventListener('abort', () => {
        cleanup();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
