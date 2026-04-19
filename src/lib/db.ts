/**
 * SQLite database for the Ember agent.
 *
 * Tables:
 *   trades   – swap execution records
 *
 * Uses better-sqlite3 (synchronous, zero-config).
 * DB file lives at data/agent.db (gitignored).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { TradeRecord } from './types';

// ─── Singleton ──────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

function getDbPath(): string {
  // In serverless environments (Vercel/Lambda), process.cwd() is /var/task
  // which is read-only. Use /tmp for writable storage in production.
  const base = process.env.NODE_ENV === 'production' ? '/tmp' : process.cwd();
  const dir = path.join(base, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'agent.db');
}

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(getDbPath());
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

// ─── Migrations ─────────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      trade_id        TEXT PRIMARY KEY,
      command         TEXT NOT NULL,
      trade_tx_hash   TEXT UNIQUE,
      status          TEXT NOT NULL DEFAULT 'pending',
      gas_used        TEXT,
      gas_cost_usd    REAL,
      compute_cost_usd REAL,
      builder_code    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Persistent text → embedding cache. Text hash is stable, so rows never
    -- expire; the same market question always maps to the same vector.
    CREATE TABLE IF NOT EXISTS embeddings (
      hash        TEXT PRIMARY KEY,
      model       TEXT NOT NULL,
      dim         INTEGER NOT NULL,
      vec         BLOB NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- Short-lived cache for computed similar-market results. Keyed by a hash
    -- of the request params; callers check created_at against a TTL.
    CREATE TABLE IF NOT EXISTS similar_cache (
      cache_key   TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- Polymarket↔Kalshi best-match cache. Separate from similar_cache so
    -- price-driven invalidations don't wipe the expensive similarity result.
    -- Keyed by (poly_key, corpus_version) — version is a hash of the current
    -- Kalshi ticker set, so the cache auto-invalidates when the corpus shifts.
    CREATE TABLE IF NOT EXISTS match_cache (
      poly_key        TEXT NOT NULL,
      corpus_version  TEXT NOT NULL,
      best_ticker     TEXT NOT NULL,
      similarity      REAL NOT NULL,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (poly_key, corpus_version)
    );
  `);
}

// ─── Embedding cache ────────────────────────────────────────────────────────

export function getEmbeddingsBatch(
  hashes: string[],
  model: string,
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (hashes.length === 0) return out;
  const db = getDb();
  // Chunk to stay well under SQLite's SQLITE_MAX_VARIABLE_NUMBER (999 on
  // older builds, 32766 on newer). A full-Polymarket scan can hand us 40k+
  // hashes so any unchunked IN clause blows up.
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT hash, dim, vec FROM embeddings WHERE model = ? AND hash IN (${placeholders})`,
      )
      .all(model, ...chunk) as { hash: string; dim: number; vec: Buffer }[];
    for (const row of rows) {
      const view = new Float32Array(
        row.vec.buffer,
        row.vec.byteOffset,
        row.vec.byteLength / 4,
      );
      // Copy so the result survives the Buffer going out of scope.
      out.set(row.hash, new Float32Array(view));
    }
  }
  return out;
}

export function putEmbeddingsBatch(
  rows: { hash: string; model: string; vec: Float32Array }[],
): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO embeddings (hash, model, dim, vec, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      stmt.run(r.hash, r.model, r.vec.length, Buffer.from(r.vec.buffer), now);
    }
  });
  tx(rows);
}

// ─── Polymarket↔Kalshi match cache ─────────────────────────────────────────

export interface CachedMatch {
  bestTicker: string;
  similarity: number;
}

export function getMatchCache(
  polyKey: string,
  corpusVersion: string,
  ttlMs: number,
): CachedMatch | null {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT best_ticker, similarity, created_at FROM match_cache WHERE poly_key = ? AND corpus_version = ?',
    )
    .get(polyKey, corpusVersion) as
    | { best_ticker: string; similarity: number; created_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > ttlMs) return null;
  return { bestTicker: row.best_ticker, similarity: row.similarity };
}

export function putMatchCache(
  polyKey: string,
  corpusVersion: string,
  bestTicker: string,
  similarity: number,
): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO match_cache (poly_key, corpus_version, best_ticker, similarity, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(polyKey, corpusVersion, bestTicker, similarity, Date.now());
}

/** Batch lookup — avoids 1 SQLite call per poly on a 5k-poly scan. */
export function getMatchCacheBatch(
  polyKeys: string[],
  corpusVersion: string,
  ttlMs: number,
): Map<string, CachedMatch> {
  const out = new Map<string, CachedMatch>();
  if (polyKeys.length === 0) return out;
  const db = getDb();
  const cutoff = Date.now() - ttlMs;
  // Chunk to stay under SQLite's parameter cap — safe across versions.
  const CHUNK = 500;
  for (let i = 0; i < polyKeys.length; i += CHUNK) {
    const chunk = polyKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT poly_key, best_ticker, similarity FROM match_cache
         WHERE corpus_version = ? AND created_at >= ? AND poly_key IN (${placeholders})`,
      )
      .all(corpusVersion, cutoff, ...chunk) as {
        poly_key: string; best_ticker: string; similarity: number;
      }[];
    for (const r of rows) {
      out.set(r.poly_key, { bestTicker: r.best_ticker, similarity: r.similarity });
    }
  }
  return out;
}

export function putMatchCacheBatch(
  rows: { polyKey: string; corpusVersion: string; bestTicker: string; similarity: number }[],
): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO match_cache (poly_key, corpus_version, best_ticker, similarity, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      stmt.run(r.polyKey, r.corpusVersion, r.bestTicker, r.similarity, now);
    }
  });
  tx(rows);
}

/**
 * Prune match_cache rows whose corpus_version no longer matches the
 * current one — called opportunistically so the table doesn't grow
 * unboundedly across Kalshi universe churn.
 */
export function pruneMatchCacheExcept(currentVersion: string): void {
  const db = getDb();
  db.prepare('DELETE FROM match_cache WHERE corpus_version != ?').run(currentVersion);
}

// ─── Similar-pairs cache (short TTL) ────────────────────────────────────────

export function getSimilarCache(
  cacheKey: string,
  ttlMs: number,
): unknown | null {
  const db = getDb();
  const row = db
    .prepare('SELECT payload, created_at FROM similar_cache WHERE cache_key = ?')
    .get(cacheKey) as { payload: string; created_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > ttlMs) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function putSimilarCache(cacheKey: string, payload: unknown): void {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO similar_cache (cache_key, payload, created_at) VALUES (?, ?, ?)',
  ).run(cacheKey, JSON.stringify(payload), Date.now());
}

// ─── Payment queries ────────────────────────────────────────────────────────

// ─── Trade queries ──────────────────────────────────────────────────────────

export function insertTrade(t: Omit<TradeRecord, 'created_at'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO trades (trade_id, command, trade_tx_hash, status, gas_used, gas_cost_usd, compute_cost_usd, builder_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.trade_id, t.command, t.trade_tx_hash, t.status, t.gas_used, t.gas_cost_usd, t.compute_cost_usd, t.builder_code);
}

export function updateTradeStatus(
  tradeId: string,
  updates: { status: string; trade_tx_hash?: string; gas_used?: string; gas_cost_usd?: number; compute_cost_usd?: number; builder_code?: string },
): void {
  const db = getDb();
  const sets: string[] = ['status = ?'];
  const vals: unknown[] = [updates.status];

  if (updates.trade_tx_hash !== undefined) { sets.push('trade_tx_hash = ?'); vals.push(updates.trade_tx_hash); }
  if (updates.gas_used !== undefined)      { sets.push('gas_used = ?');      vals.push(updates.gas_used); }
  if (updates.gas_cost_usd !== undefined)  { sets.push('gas_cost_usd = ?');  vals.push(updates.gas_cost_usd); }
  if (updates.compute_cost_usd !== undefined) { sets.push('compute_cost_usd = ?'); vals.push(updates.compute_cost_usd); }
  if (updates.builder_code !== undefined) { sets.push('builder_code = ?'); vals.push(updates.builder_code); }

  vals.push(tradeId);
  db.prepare(`UPDATE trades SET ${sets.join(', ')} WHERE trade_id = ?`).run(...vals);
}

export function getRecentTrades(limit = 20): TradeRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit) as TradeRecord[];
}

// ─── Aggregation ────────────────────────────────────────────────────────────

interface TotalRow { total: number | null }

export function getTotals() {
  const db = getDb();

  const gasCost = (db.prepare(
    "SELECT COALESCE(SUM(gas_cost_usd), 0) as total FROM trades WHERE status = 'success'",
  ).get() as TotalRow).total ?? 0;

  const computeCost = (db.prepare(
    'SELECT COALESCE(SUM(compute_cost_usd), 0) as total FROM trades',
  ).get() as TotalRow).total ?? 0;

  const tradeCount = (db.prepare(
    "SELECT COUNT(*) as total FROM trades WHERE status = 'success'",
  ).get() as TotalRow).total ?? 0;

  const failedTradeCount = (db.prepare(
    "SELECT COUNT(*) as total FROM trades WHERE status = 'failed'",
  ).get() as TotalRow).total ?? 0;

  return {
    gas_spend_usd: gasCost,
    compute_spend_usd: computeCost,
    net_profit_usd: -gasCost - computeCost,
    trade_count: tradeCount,
    failed_trade_count: failedTradeCount,
  };
}
