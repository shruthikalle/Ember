'use client';

import { useState, useCallback, useEffect } from 'react';
import { loadHoldings, removeHolding } from '@/src/components/MemecoinHoldings';
import type { Holding } from '@/src/components/MemecoinHoldings';
import MemecoinTradeModal from '@/src/components/MemecoinTradeModal';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(price: number): string {
  if (!isFinite(price) || price === 0) return '$—';
  if (price < 0.000001) return `$${price.toExponential(2)}`;
  if (price < 0.01) return `$${price.toFixed(6)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function formatCompact(n: number): string {
  if (!isFinite(n) || n === 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)    return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Token Logo ───────────────────────────────────────────────────────────────

function TokenLogo({ logoURI, symbol, size = 10 }: { logoURI?: string; symbol: string; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const sz = `w-${size} h-${size}`;

  if (logoURI && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoURI}
        alt={symbol}
        className={`${sz} rounded-full object-cover shrink-0`}
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
    <div className={`${sz} rounded-full ${colorClass} flex items-center justify-center text-white font-bold shrink-0`}
      style={{ fontSize: size >= 10 ? '16px' : '11px' }}>
      {letter}
    </div>
  );
}

// ─── Live price hook ──────────────────────────────────────────────────────────

interface LiveData {
  price: number;
  loading: boolean;
}

function useLivePrices(holdings: Holding[]): Map<string, LiveData> {
  const [prices, setPrices] = useState<Map<string, LiveData>>(new Map());

  useEffect(() => {
    if (holdings.length === 0) return;

    // Set loading state for all
    setPrices(prev => {
      const next = new Map(prev);
      for (const h of holdings) {
        if (!next.has(h.address)) {
          next.set(h.address, { price: 0, loading: true });
        }
      }
      return next;
    });

    // Fetch prices in parallel (via birdeye API route)
    const fetchAll = async () => {
      await Promise.all(
        holdings.map(async (h) => {
          try {
            const res = await fetch(`/api/birdeye/price?address=${h.address}`);
            if (!res.ok) return;
            const json = await res.json();
            const price: number = json?.price ?? json?.data?.price ?? 0;
            setPrices(prev => {
              const next = new Map(prev);
              next.set(h.address, { price, loading: false });
              return next;
            });
          } catch {
            setPrices(prev => {
              const next = new Map(prev);
              next.set(h.address, { price: 0, loading: false });
              return next;
            });
          }
        })
      );
    };

    fetchAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings.map(h => h.address).join(',')]);

  return prices;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AssetsPage() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [sellModal, setSellModal] = useState<Holding | null>(null);

  useEffect(() => {
    setIsClient(true);
    try {
      const saved = localStorage.getItem('predictions_wallet_address');
      if (saved) setWalletAddress(saved);
    } catch { /* ignore */ }
    setHoldings(loadHoldings());
  }, []);

  useEffect(() => {
    if (!isClient) return;
    try {
      if (walletAddress) {
        localStorage.setItem('predictions_wallet_address', walletAddress);
      } else {
        localStorage.removeItem('predictions_wallet_address');
      }
    } catch { /* ignore */ }
  }, [walletAddress, isClient]);

  const connectWallet = useCallback(async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    const solana = (window as any).solana;
    if (solana?.isPhantom) {
      try {
        await solana.connect();
        const addr: string = solana.publicKey.toString();
        setWalletAddress(addr);
        return addr;
      } catch { /* fall through */ }
    }
    const ethereum = (window as any).phantom?.ethereum || (window as any).ethereum;
    if (!ethereum) {
      alert('No wallet found. Please install Phantom or MetaMask.');
      return null;
    }
    try {
      const accounts: string[] = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts.length) return null;
      setWalletAddress(accounts[0]);
      return accounts[0];
    } catch {
      return null;
    }
  }, []);

  const handleSellSuccess = useCallback((address: string) => {
    removeHolding(address);
    setHoldings(loadHoldings());
    setSellModal(null);
  }, []);

  const livePrices = useLivePrices(holdings);

  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;

  // ── Portfolio stats ──
  const totalCostBasis = holdings.reduce((sum, h) => sum + h.totalSolSpent, 0);
  const totalCurrentValue = holdings.reduce((sum, h) => {
    const live = livePrices.get(h.address);
    if (!live || live.loading || live.price === 0) return sum + (h.amountHeld * h.avgPrice);
    return sum + h.amountHeld * live.price;
  }, 0);
  const totalPnlUsd = totalCurrentValue - (totalCostBasis * /* approx SOL price */ 145);
  const anyLoading = [...livePrices.values()].some(v => v.loading);

  return (
    <div className="relative min-h-screen">
      {/* ─── Top nav ────────────────────────────────────────────── */}
      <header className="relative z-20">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <a href="/" className="flex items-center">
              <span className="text-[18px] font-black tracking-[0.18em] text-white">EMBER</span>
            </a>

            <nav className="hidden md:flex items-center gap-1">
              <a href="/" className="btn-ghost">Dashboard</a>
              <a href="/#try-it" className="btn-ghost">Swap</a>
              <a href="/perps" className="btn-ghost">Perps</a>
              <a href="/predictions" className="btn-ghost">Predictions</a>
              <a href="/portfolio" className="btn-ghost">Portfolio</a>
              <a href="/memecoins" className="btn-ghost">Memecoins</a>
              <span className="btn-ghost !text-[var(--color-accent)]">Assets</span>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {isClient && (
              walletAddress ? (
                <div className="chip">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4ade80] pulse-dot" />
                  <span className="mono text-[12px]">{shortWallet}</span>
                </div>
              ) : (
                <button className="btn-primary text-[13px]" onClick={connectWallet}>
                  Connect Wallet
                </button>
              )
            )}
          </div>
        </div>
      </header>

      {/* ─── Hero ───────────────────────────────────────────────── */}
      <section className="relative z-10 text-center max-w-3xl mx-auto px-6 pt-10 pb-8">
        <div className="inline-flex items-center gap-2 pill pill-accent mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ff7a3d] pulse-dot" />
          Your Memecoin Portfolio
        </div>
        <h1 className="text-[36px] md:text-[48px] leading-[1.05] tracking-[-0.03em] font-normal">
          My
          <br />
          <span className="serif italic text-[42px] md:text-[56px]">
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #ff7a3d 0%, #ff5722 50%, #e84e5c 100%)' }}
            >
              assets
            </span>
          </span>
        </h1>
        <p className="mt-4 text-[15px] text-[var(--color-text-dim)] max-w-xl mx-auto leading-relaxed">
          Track and manage your Solana memecoin holdings. Sell any position directly from here.
        </p>
      </section>

      {/* ─── Main content ───────────────────────────────────────── */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 lg:px-8 pb-24">

        {/* Empty state */}
        {isClient && holdings.length === 0 && (
          <div className="card w-full p-16 flex flex-col items-center gap-5 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
            </div>
            <div>
              <p className="text-[15px] font-semibold" style={{ color: '#a1a1aa' }}>No holdings yet</p>
              <p className="text-[13px] mt-1" style={{ color: '#52525b' }}>
                Buy tokens on the{' '}
                <a href="/memecoins" className="text-[#ff7a3d] hover:underline underline-offset-2">memecoins page</a>
                {' '}and they&apos;ll appear here.
              </p>
            </div>
            <a
              href="/memecoins"
              className="btn-primary text-[13px] mt-2"
            >
              Browse Memecoins →
            </a>
          </div>
        )}

        {/* Holdings table */}
        {isClient && holdings.length > 0 && (
          <>
            {/* Stats row */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
              <div className="card px-5 py-4">
                <p className="text-[11px] font-medium tracking-widest uppercase mb-1" style={{ color: '#52525b' }}>Positions</p>
                <p className="text-[22px] font-semibold num" style={{ color: '#f5f5f7' }}>{holdings.length}</p>
              </div>
              <div className="card px-5 py-4">
                <p className="text-[11px] font-medium tracking-widest uppercase mb-1" style={{ color: '#52525b' }}>SOL Invested</p>
                <p className="text-[22px] font-semibold num" style={{ color: '#f5f5f7' }}>{totalCostBasis.toFixed(3)} SOL</p>
              </div>
              <div className="card px-5 py-4 col-span-2 md:col-span-1">
                <p className="text-[11px] font-medium tracking-widest uppercase mb-1" style={{ color: '#52525b' }}>
                  {anyLoading ? 'Loading prices…' : 'Est. P&L'}
                </p>
                <p
                  className="text-[22px] font-semibold num"
                  style={{ color: anyLoading ? '#52525b' : totalPnlUsd >= 0 ? '#4ade80' : '#fb7185' }}
                >
                  {anyLoading ? '—' : `${totalPnlUsd >= 0 ? '+' : ''}${formatCompact(Math.abs(totalPnlUsd))}`}
                </p>
              </div>
            </div>

            {/* Table card */}
            <div className="card w-full overflow-hidden">
              {/* Column headers */}
              <div
                className="hidden sm:grid px-4 py-2.5 border-b border-white/8 text-[10px] font-medium tracking-widest uppercase"
                style={{ color: '#52525b', gridTemplateColumns: '1fr 110px 110px 110px 100px 100px', gap: '12px' }}
              >
                <span>Token</span>
                <span className="text-right">Avg Price</span>
                <span className="text-right">Current</span>
                <span className="text-right">Amount</span>
                <span className="text-right">P&L</span>
                <span className="text-right">Action</span>
              </div>

              {/* Rows */}
              <div className="divide-y divide-white/5">
                {holdings.map(h => {
                  const live = livePrices.get(h.address);
                  const currentPrice = live && !live.loading && live.price > 0 ? live.price : h.avgPrice;
                  const currentValue = h.amountHeld * currentPrice;
                  const costBasisUsd = h.amountHeld * h.avgPrice;
                  const pnlUsd = currentValue - costBasisUsd;
                  const pnlPct = costBasisUsd > 0 ? (pnlUsd / costBasisUsd) * 100 : 0;
                  const pnlPos = pnlUsd >= 0;

                  return (
                    <div key={h.address} className="grid items-center px-4 py-4"
                      style={{ gridTemplateColumns: '1fr 110px 110px 110px 100px 100px', gap: '12px' }}>

                      {/* Token identity */}
                      <div className="flex items-center gap-3 min-w-0">
                        <TokenLogo logoURI={h.logoURI} symbol={h.symbol} size={10} />
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold truncate" style={{ color: '#f5f5f7' }}>{h.symbol}</p>
                          <p className="text-[11px] truncate" style={{ color: '#52525b' }}>{timeAgo(h.boughtAt)}</p>
                        </div>
                      </div>

                      {/* Avg buy price */}
                      <span className="hidden sm:block text-right text-[12px] num" style={{ color: '#a1a1aa' }}>
                        {formatPrice(h.avgPrice)}
                      </span>

                      {/* Live price */}
                      <span className="hidden sm:block text-right text-[12px] num" style={{ color: '#f5f5f7' }}>
                        {live?.loading ? (
                          <span className="inline-block w-14 h-3 bg-white/10 rounded animate-pulse" />
                        ) : formatPrice(currentPrice)}
                      </span>

                      {/* Amount */}
                      <span className="hidden sm:block text-right text-[12px] num" style={{ color: '#a1a1aa' }}>
                        {h.amountHeld.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>

                      {/* P&L */}
                      <div className="hidden sm:flex flex-col items-end">
                        {live?.loading ? (
                          <span className="inline-block w-12 h-3 bg-white/10 rounded animate-pulse" />
                        ) : (
                          <>
                            <span className="text-[12px] font-semibold num" style={{ color: pnlPos ? '#4ade80' : '#fb7185' }}>
                              {pnlPos ? '+' : ''}{pnlPct.toFixed(1)}%
                            </span>
                            <span className="text-[10px] num" style={{ color: pnlPos ? '#4ade8080' : '#fb718580' }}>
                              {pnlPos ? '+' : ''}{formatCompact(Math.abs(pnlUsd))}
                            </span>
                          </>
                        )}
                      </div>

                      {/* Sell button */}
                      <div className="flex items-center justify-end">
                        <button
                          onClick={() => setSellModal(h)}
                          className="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold transition-all"
                          style={{ background: 'rgba(251,113,133,0.12)', color: '#fb7185', border: '1px solid rgba(251,113,133,0.2)' }}
                        >
                          Sell
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="px-4 py-3 border-t border-white/5 flex items-center justify-between">
                <span className="text-[11px]" style={{ color: '#52525b' }}>
                  {holdings.length} position{holdings.length !== 1 ? 's' : ''}
                  {' · '}holdings tracked locally in your browser
                </span>
                <a href="/memecoins" className="text-[11px] text-[#ff7a3d] hover:underline underline-offset-2">
                  + Buy more →
                </a>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ─── Sell modal ─────────────────────────────────────────── */}
      {sellModal && (
        <MemecoinTradeModal
          isOpen={true}
          onClose={() => setSellModal(null)}
          mode="sell"
          tokenAddress={sellModal.address}
          tokenSymbol={sellModal.symbol}
          tokenPrice={livePrices.get(sellModal.address)?.price || sellModal.avgPrice}
          logoURI={sellModal.logoURI}
          walletAddress={walletAddress ?? undefined}
          onConnectWallet={connectWallet}
          defaultSellAmount={sellModal.amountHeld}
          onSellSuccess={() => handleSellSuccess(sellModal.address)}
        />
      )}

      {/* ─── Footer ─────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-[var(--color-border)]">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-[12px] text-[var(--color-text-mute)]">
            <span className="text-[var(--color-text-dim)] font-medium">ember</span>
            <span>·</span>
          </div>
          <div className="flex items-center gap-5 text-[12px] text-[var(--color-text-mute)]">
            <a href="/" className="hover:text-[var(--color-text)] transition-colors">Home</a>
            <a href="/perps" className="hover:text-[var(--color-text)] transition-colors">Perps</a>
            <a href="/predictions" className="hover:text-[var(--color-text)] transition-colors">Predictions</a>
            <a href="/memecoins" className="hover:text-[var(--color-text)] transition-colors">Memecoins</a>
            <a href="/assets" className="hover:text-[var(--color-text)] transition-colors">Assets</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
