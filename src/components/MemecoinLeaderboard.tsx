'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import MemecoinTokenCard from './MemecoinTokenCard';
import MemecoinTradeModal from './MemecoinTradeModal';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MemeToken {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24hPercent: number;
  volume24hUSD: number;
  volume24hChangePercent?: number;
  marketcap: number;
  logoURI?: string;
  liquidity?: number;
  holder?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(price: number): string {
  if (!isFinite(price) || price === 0) return '$0.000000';
  if (price < 0.01) return `$${price.toFixed(6)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function formatCompact(n: number): string {
  if (!isFinite(n) || n === 0) return '$0';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 animate-pulse">
      <div className="w-7 h-5 bg-white/10 rounded" />
      <div className="w-8 h-8 rounded-full bg-white/10 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="h-3.5 w-24 bg-white/10 rounded mb-1.5" />
        <div className="h-2.5 w-16 bg-white/10 rounded" />
      </div>
      <div className="hidden sm:block w-20 h-3.5 bg-white/10 rounded" />
      <div className="hidden md:block w-14 h-3.5 bg-white/10 rounded" />
      <div className="hidden lg:block w-20 h-3.5 bg-white/10 rounded" />
    </div>
  );
}

// ─── Token Logo ───────────────────────────────────────────────────────────────

function TokenLogo({ logoURI, symbol }: { logoURI?: string; symbol: string }) {
  const [imgError, setImgError] = useState(false);

  if (logoURI && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoURI}
        alt={symbol}
        className="w-8 h-8 rounded-full object-cover"
        onError={() => setImgError(true)}
      />
    );
  }

  const letter = symbol.charAt(0).toUpperCase();
  const colors = [
    'bg-orange-500', 'bg-purple-500', 'bg-blue-500', 'bg-green-500',
    'bg-pink-500', 'bg-yellow-500', 'bg-cyan-500', 'bg-red-500',
  ];
  const colorClass = colors[letter.charCodeAt(0) % colors.length];

  return (
    <div className={`w-8 h-8 rounded-full ${colorClass} flex items-center justify-center text-white text-xs font-bold shrink-0`}>
      {letter}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface MemecoinLeaderboardProps {
  onTokensLoaded?: (tokens: MemeToken[]) => void;
  walletAddress?: string | null;
  onConnectWallet?: () => Promise<string | null>;
}

export default function MemecoinLeaderboard({
  onTokensLoaded,
  walletAddress,
  onConnectWallet,
}: MemecoinLeaderboardProps = {}) {
  const [tokens, setTokens] = useState<MemeToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [tradeModal, setTradeModal] = useState<{
    mode: 'buy' | 'sell';
    token: MemeToken;
  } | null>(null);

  // ── Use a ref for the callback so it never causes fetchTokens to re-run ──────
  const onTokensLoadedRef = useRef(onTokensLoaded);
  useEffect(() => { onTokensLoadedRef.current = onTokensLoaded; });

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/birdeye/trending');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: MemeToken[] = Array.isArray(data) ? data : (data.tokens ?? data.data ?? []);
      const sliced = list.slice(0, 20);
      setTokens(sliced);
      onTokensLoadedRef.current?.(sliced);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, []); // ← empty deps — no inline callbacks in the dep array

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleRowClick = (address: string) => {
    setSelectedAddress(prev => (prev === address ? null : address));
  };

  const openTrade = (mode: 'buy' | 'sell', token: MemeToken, e: React.MouseEvent) => {
    e.stopPropagation();
    setTradeModal({ mode, token });
  };

  return (
    <>
      <div className="card w-full overflow-hidden">
        {/* ── Header ──────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[15px] font-semibold text-[#f5f5f7]">Trending on pump.fun</h2>
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase"
              style={{ background: 'rgba(153,69,255,0.15)', color: '#9945ff', border: '1px solid rgba(153,69,255,0.3)' }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="12" /></svg>
              Solana
            </span>
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase"
              style={{ background: 'rgba(34,197,94,0.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.2)' }}
            >
              <span className="w-1 h-1 rounded-full bg-[#4ade80] inline-block" style={{ animation: 'pulse 2s infinite' }} />
              Live
            </span>
          </div>
          <button
            onClick={fetchTokens}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 disabled:opacity-40"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.08)' }}
            aria-label="Refresh"
          >
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={loading ? 'animate-spin' : ''}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
            Refresh
          </button>
        </div>

        {/* ── Column headers ───────────────────────────────────── */}
        <div
          className="hidden sm:grid px-4 py-2 border-b border-white/5 text-[10px] font-medium tracking-widest uppercase"
          style={{ color: '#71717a', gridTemplateColumns: '28px 1fr 100px 80px 90px 110px 100px', gap: '12px' }}
        >
          <span>#</span>
          <span>Token</span>
          <span className="text-right">Price</span>
          <span className="text-right">24h %</span>
          <span className="hidden md:block text-right">Vol Surge</span>
          <span className="hidden lg:block text-right">Volume</span>
          <span className="text-right">Trade</span>
        </div>

        {/* ── Error ────────────────────────────────────────────── */}
        {error && (
          <div className="px-4 py-6 text-center text-[13px]" style={{ color: '#fb7185' }}>
            {error}
            <button onClick={fetchTokens} className="ml-3 underline underline-offset-2 text-[#ff7a3d]">Retry</button>
          </div>
        )}

        {/* ── Skeleton ─────────────────────────────────────────── */}
        {loading && !error && (
          <div>{Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)}</div>
        )}

        {/* ── Empty ────────────────────────────────────────────── */}
        {!loading && !error && tokens.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: '#71717a' }}>No tokens found.</div>
        )}

        {/* ── Rows ─────────────────────────────────────────────── */}
        {!loading && !error && tokens.map((token, idx) => {
          const isExpanded = selectedAddress === token.address;
          const changePositive = (token.priceChange24hPercent ?? 0) >= 0;

          return (
            <div key={token.address} className="border-b border-white/5 last:border-b-0">
              <button
                type="button"
                onClick={() => handleRowClick(token.address)}
                className="w-full text-left transition-colors duration-150"
                style={{ background: isExpanded ? 'rgba(255,122,61,0.06)' : 'transparent' }}
                onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.025)'; }}
                onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                <div
                  className="grid items-center px-4 py-3"
                  style={{ gridTemplateColumns: '28px 1fr 100px 80px 90px 110px 100px', gap: '12px' }}
                >
                  {/* Rank */}
                  <span className="text-[12px] font-medium num" style={{ color: '#52525b' }}>{idx + 1}</span>

                  {/* Token */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    <TokenLogo logoURI={token.logoURI} symbol={token.symbol} />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium truncate" style={{ color: '#f5f5f7' }}>{token.symbol}</p>
                      <p className="text-[11px] truncate" style={{ color: '#71717a' }}>{token.name}</p>
                    </div>
                  </div>

                  {/* Price */}
                  <span className="text-right text-[13px] font-medium num" style={{ color: '#f5f5f7' }}>
                    {formatPrice(token.price)}
                  </span>

                  {/* 24h % */}
                  <span className="text-right text-[12px] font-semibold num" style={{ color: changePositive ? '#4ade80' : '#fb7185' }}>
                    {changePositive ? '+' : ''}{(token.priceChange24hPercent ?? 0).toFixed(2)}%
                  </span>

                  {/* Vol Surge */}
                  <span className="hidden md:block text-right text-[12px] font-semibold num" style={{ color: '#fb923c' }}>
                    {(token.volume24hChangePercent ?? 0) > 100
                      ? `+${((token.volume24hChangePercent ?? 0) / 100).toFixed(0)}x`
                      : (token.priceChange24hPercent > 0 ? `+${token.priceChange24hPercent.toFixed(1)}%` : '—')}
                  </span>

                  {/* Volume */}
                  <span className="hidden lg:block text-right text-[12px] num" style={{ color: '#a1a1aa' }}>
                    {formatCompact(token.volume24hUSD)}
                  </span>

                  {/* Buy button only — sell is handled from My Holdings */}
                  <div className="flex items-center justify-end" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={e => openTrade('buy', token, e)}
                      className="px-3 py-1 rounded text-[11px] font-semibold transition-all"
                      style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)' }}
                    >
                      Buy
                    </button>
                  </div>
                </div>
              </button>

              {/* Expanded token card */}
              {isExpanded && (
                <div className="px-4 pb-4" style={{ background: 'rgba(255,122,61,0.03)' }}>
                  <MemecoinTokenCard
                    address={token.address}
                    symbol={token.symbol}
                    onBuy={() => setTradeModal({ mode: 'buy', token })}
                    onSell={() => {/* sell from My Holdings section */}}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Trade Modal ───────────────────────────────────────── */}
      {tradeModal && (
        <MemecoinTradeModal
          isOpen={true}
          onClose={() => setTradeModal(null)}
          mode={tradeModal.mode}
          tokenAddress={tradeModal.token.address}
          tokenSymbol={tradeModal.token.symbol}
          tokenPrice={tradeModal.token.price}
          logoURI={tradeModal.token.logoURI}
          walletAddress={walletAddress ?? undefined}
          onConnectWallet={onConnectWallet}
        />
      )}
    </>
  );
}
