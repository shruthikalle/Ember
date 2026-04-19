/**
 * OpenAI embeddings helper with a SQLite-backed persistent cache plus a
 * process-local memo map.
 *
 * Uses text-embedding-3-small (1536-dim, $0.02 / 1M tokens). Vectors are
 * keyed by sha1(text) and stored in SQLite as raw Float32 bytes (6,144 B per
 * row). Memo hits are free; DB hits are ~100µs; only previously-unseen texts
 * round-trip to OpenAI.
 */

import crypto from 'node:crypto';
import { getEmbeddingsBatch, putEmbeddingsBatch } from './db';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;
const CONCURRENCY = 8;

// Process-local memo. Persists for the lifetime of the Node process so the
// same request doesn't hit SQLite twice.
const memo = new Map<string, Float32Array>();

function keyOf(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Embed a list of texts. Preserves input order. Returns Float32Array vectors.
 *   memo → SQLite → OpenAI (in order); hits early layers short-circuit.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const apiKey = process.env.OPENAI_API_KEY;

  const hashes = texts.map(keyOf);
  const out: (Float32Array | null)[] = texts.map(() => null);

  // Layer 1: memo.
  const diskNeed: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = memo.get(hashes[i]);
    if (cached) out[i] = cached;
    else diskNeed.push(i);
  }

  // Layer 2: SQLite (single batched query).
  if (diskNeed.length > 0) {
    const diskHashes = Array.from(new Set(diskNeed.map((i) => hashes[i])));
    const diskHit = getEmbeddingsBatch(diskHashes, EMBED_MODEL);
    for (const i of diskNeed) {
      const vec = diskHit.get(hashes[i]);
      if (vec) {
        out[i] = vec;
        memo.set(hashes[i], vec);
      }
    }
  }

  // Layer 3: OpenAI for whatever's still missing.
  const apiNeed: { idx: number; text: string; hash: string }[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (out[i] === null) apiNeed.push({ idx: i, text: texts[i], hash: hashes[i] });
  }

  if (apiNeed.length > 0) {
    if (!apiKey) {
      throw new Error(
        `OPENAI_API_KEY is not set — required to embed ${apiNeed.length} uncached texts`,
      );
    }

    // De-dupe by hash so identical texts don't get embedded twice.
    const byHash = new Map<string, { idx: number; text: string; hash: string }[]>();
    for (const item of apiNeed) {
      const arr = byHash.get(item.hash) ?? [];
      arr.push(item);
      byHash.set(item.hash, arr);
    }
    const uniqueItems = Array.from(byHash.values()).map((g) => g[0]);

    const chunks: typeof uniqueItems[] = [];
    for (let i = 0; i < uniqueItems.length; i += BATCH_SIZE) {
      chunks.push(uniqueItems.slice(i, i + BATCH_SIZE));
    }

    const toPersist: { hash: string; model: string; vec: Float32Array }[] = [];

    // Retry with exponential backoff on OpenAI 429 (rate limit) or 5xx.
    // A full Polymarket corpus scan (~47k markets, ~20M+ tokens) trips the
    // 1M TPM ceiling, and we want the scan to simply pace itself and
    // complete rather than fail the whole request.
    async function embedChunkWithRetry(
      chunk: typeof uniqueItems,
    ): Promise<{ embedding: number[]; index: number }[]> {
      let attempt = 0;
      const MAX_ATTEMPTS = 6;
      while (true) {
        const res = await fetch(OPENAI_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: EMBED_MODEL, input: chunk.map((c) => c.text) }),
        });

        if (res.ok) {
          const data: { data: { embedding: number[]; index: number }[] } = await res.json();
          return data.data;
        }

        const body = await res.text();
        const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (!transient || attempt >= MAX_ATTEMPTS - 1) {
          throw new Error(`OpenAI embeddings error (${res.status}): ${body}`);
        }

        // Prefer the server-suggested retry window when it's there.
        const retryAfter = Number(res.headers.get('retry-after'));
        const hintedMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        const m = body.match(/try again in (\d+(?:\.\d+)?)(ms|s)/i);
        const msgMs = m ? (m[2].toLowerCase() === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1])) : 0;
        const backoffMs = Math.max(
          hintedMs,
          msgMs,
          500 * Math.pow(2, attempt) + Math.random() * 250,
        );
        await new Promise((r) => setTimeout(r, Math.min(backoffMs, 30_000)));
        attempt++;
      }
    }

    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const group = chunks.slice(i, i + CONCURRENCY);
      await Promise.all(group.map(async (chunk) => {
        const items = await embedChunkWithRetry(chunk);
        for (const item of items) {
          const src = chunk[item.index];
          const vec = new Float32Array(item.embedding);
          memo.set(src.hash, vec);
          toPersist.push({ hash: src.hash, model: EMBED_MODEL, vec });
          // Backfill all input indexes that shared this hash.
          for (const d of byHash.get(src.hash) ?? []) out[d.idx] = vec;
        }
      }));
    }

    // Persist to SQLite in one transaction.
    if (toPersist.length > 0) putEmbeddingsBatch(toPersist);
  }

  return out as Float32Array[];
}

/**
 * Unit-normalize a vector in place and return it. After normalization, cosine
 * similarity simplifies to dot product.
 */
export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Dot product of two equal-length Float32Arrays. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
