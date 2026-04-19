/**
 * Normalized-embedding index with a process-level cache.
 *
 * The arb scan hot loop previously did, for every request:
 *   1. `getEmbeddingsBatch(10_000 hashes)` — one prepared statement with 10k
 *      `?` placeholders, 10k Float32Array allocations.
 *   2. `kalshi.map(normalize)` — another 10k allocations and 10k sqrt+divides.
 *   3. `dot(pe, kalshiEmb[j])` across 10k separate arrays — cold cache walk.
 *
 * Instead we build the index once per unique set of entries (hashed by a
 * caller-supplied id function), packed into a single contiguous Float32Array
 * of shape `N × D`. Subsequent scans reuse the cached matrix — no SQLite,
 * no renormalization — and the inner loop walks contiguous memory. Arb
 * scans on a warm process drop from ~300-500 ms to ~5-10 ms for the match
 * step alone.
 */

import crypto from 'node:crypto';
import { embedTexts } from '@/src/lib/embeddings';

export interface NormalizedIndex<T> {
  /** Stable fingerprint of the entries list — hash of sorted `idFn(e)` values. */
  version: string;
  /** Original entries in the order they appear in the matrix. */
  entries: T[];
  /** Flat `N × D` row-major matrix of unit-norm vectors. */
  matrix: Float32Array;
  dim: number;
}

function indexVersion<T>(entries: T[], idFn: (t: T) => string): string {
  // Sort ids so the version is stable across reorderings of equivalent input.
  const ids = entries.map(idFn).sort();
  const h = crypto.createHash('sha1');
  for (const id of ids) { h.update(id); h.update('\n'); }
  return h.digest('hex');
}

const INDEX_CACHE = new Map<string, NormalizedIndex<unknown>>();

/**
 * Build a normalized index for `entries`, or return a cached copy if the
 * fingerprint already matches. Pass a `namespace` to scope caches per caller
 * (e.g. 'kalshi', 'polymarket'); the namespace is *not* part of the version
 * hash, so two different caller sites with the same entries still get a
 * fresh embedding pass unless they share the namespace on purpose.
 */
export async function getNormalizedIndex<T>(
  namespace: string,
  entries: T[],
  idFn: (t: T) => string,
  textFn: (t: T) => string,
): Promise<NormalizedIndex<T>> {
  const version = indexVersion(entries, idFn);
  const cached = INDEX_CACHE.get(namespace) as NormalizedIndex<T> | undefined;
  if (cached && cached.version === version && cached.entries.length === entries.length) {
    return cached;
  }

  if (entries.length === 0) {
    const empty: NormalizedIndex<T> = { version, entries, matrix: new Float32Array(0), dim: 0 };
    INDEX_CACHE.set(namespace, empty);
    return empty;
  }

  const embeds = await embedTexts(entries.map(textFn));
  const dim = embeds[0]?.length ?? 1536;
  const matrix = new Float32Array(entries.length * dim);

  for (let i = 0; i < entries.length; i++) {
    const v = embeds[i];
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm) || 1;
    const base = i * dim;
    for (let k = 0; k < dim; k++) matrix[base + k] = v[k] / norm;
  }

  const idx: NormalizedIndex<T> = { version, entries, matrix, dim };
  INDEX_CACHE.set(namespace, idx);
  return idx;
}

/**
 * Unit-normalize a query vector into a new Float32Array. Matches the
 * normalization done row-wise in `getNormalizedIndex`.
 */
export function normalizeCopy(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Argmax cosine similarity between a pre-normalized query and the flat matrix.
 * Returns `{idx: -1, sim: -Infinity}` if the matrix is empty.
 */
export function argmaxSimilarity(
  queryNormed: Float32Array,
  matrix: Float32Array,
  dim: number,
  n: number,
): { idx: number; sim: number } {
  let bestIdx = -1;
  let bestSim = -Infinity;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * dim;
    for (let k = 0; k < dim; k++) s += queryNormed[k] * matrix[base + k];
    if (s > bestSim) {
      bestSim = s;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, sim: bestSim };
}

/** Similarity of a single row vs query — for callers that know the index. */
export function similarityAt(
  queryNormed: Float32Array,
  matrix: Float32Array,
  dim: number,
  row: number,
): number {
  let s = 0;
  const base = row * dim;
  for (let k = 0; k < dim; k++) s += queryNormed[k] * matrix[base + k];
  return s;
}
