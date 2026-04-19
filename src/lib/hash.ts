/**
 * Canonical request hashing for x402 payment binding.
 *
 * Produces a deterministic SHA-256 hex string from a request body
 * so the payment is bound to a specific request.
 */

import { createHash } from 'crypto';

/**
 * Deterministic JSON serialisation (sorted keys, no whitespace).
 */
function canonicalJSON(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJSON).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const sorted = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON((obj as Record<string, unknown>)[k])}`);
    return '{' + sorted.join(',') + '}';
  }
  return String(obj);
}

/**
 * Compute a SHA-256 hex digest of a canonical JSON representation of `body`.
 *
 * Used to bind an x402 payment to a specific request so the same
 * payment proof cannot be replayed for a different command.
 */
export function computeRequestHash(body: Record<string, unknown>): string {
  const canonical = canonicalJSON(body);
  return createHash('sha256').update(canonical).digest('hex');
}
