/**
 * Market Pulse — "why is this market moving?"
 *
 * Aggregates three signals for a single Polymarket market:
 *   1. Price delta (1h / 24h)
 *   2. Recent trade activity (count, volume, velocity)
 *   3. Top whale fills in the last hour with wallet-level ROI
 *
 * All data comes from Polymarket's public data-api + clob prices-history —
 * no auth needed, no geo-block on reads.
 */

const DATA_API = 'https://data-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PulseWhale {
  address: string;
  name: string | null;
  pseudonym: string | null;
  profileImage: string | null;
  recentAction: 'BUY' | 'SELL';
  recentOutcome: 'Yes' | 'No';
  recentSize: number;
  recentPrice: number;
  recentTimestamp: number;
  recentNotional: number; // size × price in USD
  // Wallet-level aggregates (null when unavailable)
  walletTotalValue: number | null;
  walletTotalPnl: number | null;
  walletPnlPct: number | null;
  walletMarketsOpen: number | null;
}

export interface MarketPulse {
  conditionId: string;
  tokenId: string;
  priceNow: number | null;
  delta1h: number | null;       // percentage points
  delta24h: number | null;      // percentage points
  tradeCount1h: number;
  tradeVolumeUsd1h: number;
  tradeCount24h: number;
  whales: PulseWhale[];
  degraded?: string;            // reason if anything failed
}

// ─── Internal types (raw API shapes) ────────────────────────────────────────

interface RawTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;          // unix seconds
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  profileImage: string;
  transactionHash: string;
}

interface RawPosition {
  proxyWallet: string;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

interface PriceHistoryPoint {
  t: number;
  p: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getMarketPulse(params: {
  conditionId: string;
  tokenId: string;             // YES token id (for price history)
  whaleLimit?: number;
}): Promise<MarketPulse> {
  const { conditionId, tokenId, whaleLimit = 5 } = params;
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 60 * 60;
  const oneDayAgo = now - 24 * 60 * 60;

  const emptyPulse: MarketPulse = {
    conditionId,
    tokenId,
    priceNow: null,
    delta1h: null,
    delta24h: null,
    tradeCount1h: 0,
    tradeVolumeUsd1h: 0,
    tradeCount24h: 0,
    whales: [],
  };

  // Fetch trades + price history in parallel.
  const [trades, priceHistory] = await Promise.all([
    fetchTrades(conditionId).catch((err: unknown) => {
      console.warn('[market-pulse] trades fetch failed:', err);
      return [] as RawTrade[];
    }),
    fetchPriceHistory(tokenId).catch((err: unknown) => {
      console.warn('[market-pulse] prices-history fetch failed:', err);
      return [] as PriceHistoryPoint[];
    }),
  ]);

  const pulse: MarketPulse = { ...emptyPulse };

  // ── Price deltas ────────────────────────────────────────────────────────
  if (priceHistory.length > 0) {
    const last = priceHistory[priceHistory.length - 1];
    pulse.priceNow = last.p;

    const atOrBefore = (cutoff: number): PriceHistoryPoint | null => {
      for (let i = priceHistory.length - 1; i >= 0; i--) {
        if (priceHistory[i].t <= cutoff) return priceHistory[i];
      }
      return priceHistory[0] ?? null;
    };

    const p1h = atOrBefore(oneHourAgo);
    const p24h = atOrBefore(oneDayAgo);
    // Percentage points, not percent: (0.42 - 0.39) * 100 = +3pp
    pulse.delta1h = p1h ? (last.p - p1h.p) * 100 : null;
    pulse.delta24h = p24h ? (last.p - p24h.p) * 100 : null;
  }

  // ── Trade activity ──────────────────────────────────────────────────────
  const trades1h = trades.filter((t) => t.timestamp >= oneHourAgo);
  const trades24h = trades.filter((t) => t.timestamp >= oneDayAgo);

  pulse.tradeCount1h = trades1h.length;
  pulse.tradeCount24h = trades24h.length;
  pulse.tradeVolumeUsd1h = trades1h.reduce((sum, t) => sum + t.size * t.price, 0);

  // ── Whales: top distinct wallets by most recent notional in the last 24h ─
  if (trades24h.length > 0) {
    // Group by wallet, keep the biggest recent fill per wallet
    const byWallet = new Map<string, RawTrade>();
    for (const t of trades24h) {
      const existing = byWallet.get(t.proxyWallet);
      const notional = t.size * t.price;
      if (!existing || notional > existing.size * existing.price) {
        byWallet.set(t.proxyWallet, t);
      }
    }

    const sorted = Array.from(byWallet.values())
      .sort((a, b) => b.size * b.price - a.size * a.price)
      .slice(0, whaleLimit);

    // Enrich each whale with their wallet-level ROI (parallel fetch).
    const enriched = await Promise.all(
      sorted.map(async (t): Promise<PulseWhale> => {
        const base: PulseWhale = {
          address: t.proxyWallet,
          name: t.name || null,
          pseudonym: t.pseudonym || null,
          profileImage: t.profileImage || null,
          recentAction: t.side,
          recentOutcome: (t.outcome as 'Yes' | 'No') ?? 'Yes',
          recentSize: t.size,
          recentPrice: t.price,
          recentTimestamp: t.timestamp,
          recentNotional: t.size * t.price,
          walletTotalValue: null,
          walletTotalPnl: null,
          walletPnlPct: null,
          walletMarketsOpen: null,
        };
        try {
          const agg = await fetchWalletAggregate(t.proxyWallet);
          return { ...base, ...agg };
        } catch {
          return base;
        }
      }),
    );

    pulse.whales = enriched;
  }

  return pulse;
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

async function fetchTrades(conditionId: string): Promise<RawTrade[]> {
  const url = `${DATA_API}/trades?market=${conditionId}&limit=200`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as RawTrade[]) : [];
}

async function fetchPriceHistory(tokenId: string): Promise<PriceHistoryPoint[]> {
  // 1-day window at 60-minute fidelity is enough to compute 1h and 24h deltas.
  const url = `${CLOB_BASE}/prices-history?market=${tokenId}&interval=1d&fidelity=60`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.history) ? (data.history as PriceHistoryPoint[]) : [];
}

async function fetchWalletAggregate(address: string): Promise<{
  walletTotalValue: number;
  walletTotalPnl: number;
  walletPnlPct: number;
  walletMarketsOpen: number;
}> {
  const url = `${DATA_API}/positions?user=${address.toLowerCase()}&limit=100&sizeThreshold=0.01`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`positions ${res.status}`);
  const data = (await res.json()) as RawPosition[];
  if (!Array.isArray(data) || data.length === 0) {
    return { walletTotalValue: 0, walletTotalPnl: 0, walletPnlPct: 0, walletMarketsOpen: 0 };
  }
  const totalValue = data.reduce((sum, p) => sum + (p.currentValue || 0), 0);
  const totalInitial = data.reduce((sum, p) => sum + (p.initialValue || 0), 0);
  const totalPnl = data.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
  const pnlPct = totalInitial > 0 ? (totalPnl / totalInitial) * 100 : 0;
  return {
    walletTotalValue: totalValue,
    walletTotalPnl: totalPnl,
    walletPnlPct: pnlPct,
    walletMarketsOpen: data.length,
  };
}
