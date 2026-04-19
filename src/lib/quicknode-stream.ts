/**
 * QuickNode HyperCore Stream Integration for Hyperliquid
 *
 * QuickNode HyperCore provides real-time and historical access to Hyperliquid
 * exchange data via WebSocket and JSON-RPC. This module wraps the HyperCore
 * API to provide a unified interface for fetching Hyperliquid market data.
 *
 * When QUICKNODE_HL_ENDPOINT is configured, all hlInfo() calls are routed
 * through QuickNode instead of the public Hyperliquid API.
 */

const QN_ENDPOINT = process.env.QUICKNODE_HL_ENDPOINT;
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

/**
 * Check if QuickNode HyperCore is configured
 */
export function isQuickNodeEnabled(): boolean {
  return !!QN_ENDPOINT;
}

/**
 * Route Hyperliquid info requests through QuickNode HyperCore if available,
 * otherwise fall back to the public Hyperliquid API.
 */
export async function qnInfo(body: Record<string, unknown>): Promise<any> {
  if (!QN_ENDPOINT) {
    // Fallback to public API
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
    return res.json();
  }

  // Use QuickNode HyperCore
  try {
    const res = await fetch(QN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'qn_callHyperliquid',
        params: [body],
      }),
    });

    if (!res.ok) {
      console.warn('[QuickNode] Request failed, falling back to public API:', res.status);
      // Fallback to public API
      const fallbackRes = await fetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!fallbackRes.ok) throw new Error(`Hyperliquid API error: ${fallbackRes.status}`);
      return fallbackRes.json();
    }

    const data = await res.json();
    if (data.error) {
      console.warn('[QuickNode] Error response, falling back to public API:', data.error);
      // Fallback to public API
      const fallbackRes = await fetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!fallbackRes.ok) throw new Error(`Hyperliquid API error: ${fallbackRes.status}`);
      return fallbackRes.json();
    }

    return data.result || data;
  } catch (err) {
    console.warn('[QuickNode] Request error, falling back to public API:', err);
    // Fallback to public API
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
    return res.json();
  }
}
