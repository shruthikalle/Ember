'use client';

import { useState, useEffect, useCallback } from 'react';
import MemecoinTradeModal from './MemecoinTradeModal';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Holding {
  address: string;
  symbol: string;
  name: string;
  logoURI: string;
  amountHeld: number;     // token units
  totalSolSpent: number;  // SOL spent buying
  avgPrice: number;       // avg buy price in USD
  boughtAt: number;       // first purchase unix ms
}

const STORAGE_KEY = 'ember_memecoin_holdings';

export function loadHoldings(): Holding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Holding[]) : [];
  } catch { return []; }
}

export function saveHolding(h: Holding) {
  try {
    const list = loadHoldings();
    const idx = list.findIndex(x => x.address === h.address);
    if (idx >= 0) {
      // accumulate
      const existing = list[idx];
      const totalSol = existing.totalSolSpent + h.totalSolSpent;
      const totalAmt = existing.amountHeld + h.amountHeld;
      list[idx] = {
        ...existing,
        amountHeld:    totalAmt,
        totalSolSpent: totalSol,
        avgPrice:      totalAmt > 0 ? (existing.avgPrice * existing.amountHeld + h.avgPrice * h.amountHeld) / totalAmt : h.avgPrice,
      };
    } else {
      list.push(h);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

export function removeHolding(address: string) {
  try {
    const list = loadHoldings().filter(h => h.address !== address);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)   return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface MemecoinHoldingsProps {
  walletAddress?: string | null;
  onConnectWallet?: () => Promise<string | null>;
  /** Called when a holding changes so parent can react */
  onHoldingsChange?: (holdings: Holding[]) => void;
}

export default function MemecoinHoldings({ walletAddress, onConnectWallet, onHoldingsChange }: MemecoinHoldingsProps) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [sellModal, setSellModal] = useState<Holding | null>(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    const list = loadHoldings();
    setHoldings(list);
    onHoldingsChange?.(list);

    // Refresh whenever a buy or sell completes in any modal
    const handler = () => {
      const updated = loadHoldings();
      setHoldings(updated);
      onHoldingsChange?.(updated);
    };
    window.addEventListener('ember:holdings-updated', handler);
    return () => window.removeEventListener('ember:holdings-updated', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    const list = loadHoldings();
    setHoldings(list);
    onHoldingsChange?.(list);
  }, [onHoldingsChange]);

  const handleSellSuccess = useCallback((address: string) => {
    removeHolding(address);
    refresh();
    setSellModal(null);
  }, [refresh]);

  if (!isClient || holdings.length === 0) return null;

  return (
    <>
      <div className="card w-full overflow-hidden mb-6">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[15px] font-semibold text-[#f5f5f7]">My Holdings</h2>
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold"
              style={{ background: 'rgba(255,122,61,0.15)', color: '#ff7a3d', border: '1px solid rgba(255,122,61,0.25)' }}
            >
              {holdings.length} token{holdings.length !== 1 ? 's' : ''}
            </span>
          </div>
          <span className="text-[11px]" style={{ color: '#52525b' }}>Tap Sell to exit a position</span>
        </div>

        {/* Holdings list */}
        <div className="divide-y divide-white/5">
          {holdings.map(h => (
            <div key={h.address} className="flex items-center gap-3 px-4 py-3">
              {/* Logo */}
              {h.logoURI ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={h.logoURI} alt={h.symbol} className="w-9 h-9 rounded-full object-cover shrink-0" onError={e => (e.currentTarget.style.display = 'none')} />
              ) : (
                <div className="w-9 h-9 rounded-full bg-orange-500/20 flex items-center justify-center text-sm font-bold text-orange-400 shrink-0">
                  {h.symbol.charAt(0)}
                </div>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-[13px] font-semibold truncate" style={{ color: '#f5f5f7' }}>{h.symbol}</p>
                  <span className="text-[10px]" style={{ color: '#52525b' }}>·</span>
                  <span className="text-[10px]" style={{ color: '#52525b' }}>{timeAgo(h.boughtAt)}</span>
                </div>
                <p className="text-[11px] truncate" style={{ color: '#71717a' }}>
                  {h.amountHeld.toLocaleString(undefined, { maximumFractionDigits: 4 })} {h.symbol}
                  <span className="ml-2 opacity-60">· {h.totalSolSpent.toFixed(4)} SOL spent</span>
                </p>
              </div>

              {/* Sell button */}
              <button
                onClick={() => setSellModal(h)}
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold shrink-0 transition-all"
                style={{ background: 'rgba(251,113,133,0.12)', color: '#fb7185', border: '1px solid rgba(251,113,133,0.2)' }}
              >
                Sell
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Sell modal */}
      {sellModal && (
        <MemecoinTradeModal
          isOpen={true}
          onClose={() => setSellModal(null)}
          mode="sell"
          tokenAddress={sellModal.address}
          tokenSymbol={sellModal.symbol}
          tokenPrice={sellModal.avgPrice}
          logoURI={sellModal.logoURI}
          walletAddress={walletAddress ?? undefined}
          onConnectWallet={onConnectWallet}
          defaultSellAmount={sellModal.amountHeld}
          onSellSuccess={() => handleSellSuccess(sellModal.address)}
        />
      )}
    </>
  );
}
