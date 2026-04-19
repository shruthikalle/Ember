'use client';

import { useState, useCallback, useEffect } from 'react';
import PredictionMarkets from '@/src/components/PredictionMarkets';
import PredictionPositions from '@/src/components/PredictionPositions';
import ArbAnalystPanel from '@/src/components/ArbAnalystPanel';

export default function PredictionsPage() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    try {
      const saved = localStorage.getItem('predictions_wallet_address');
      if (saved) setWalletAddress(saved);
    } catch { /* ignore */ }
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

  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null;

  return (
    <div className="relative min-h-screen">
      {/* ─── Top nav (matches homepage) ─────────────────────────── */}
      <header className="relative z-20">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <a href="/" className="flex items-center">
              <span className="text-[18px] font-black tracking-[0.18em] text-white">EMBER</span>
            </a>

            <nav className="hidden md:flex items-center gap-1">
              <a href="/" className="btn-ghost">Home</a>
              <a href="/#try-it" className="btn-ghost">Swap</a>
              <a href="/perps" className="btn-ghost">Perps</a>
              <span className="btn-ghost !text-[var(--color-accent)]">Predictions</span>
              <a href="/memecoins" className="btn-ghost">Memecoins</a>
              <a href="/earn" className="btn-ghost">Earn</a>
              <a href="/#activity" className="btn-ghost">Activity</a>
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

      {/* ─── Hero header ────────────────────────────────────────── */}
      <section className="relative z-10 text-center max-w-3xl mx-auto px-6 pt-10 pb-8">
        <div className="inline-flex items-center gap-2 pill pill-accent mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ff7a3d] pulse-dot" />
          Powered by Polymarket
        </div>
        <h1 className="text-[36px] md:text-[48px] leading-[1.05] tracking-[-0.03em] font-normal">
          Prediction
          <br />
          <span className="serif italic text-[42px] md:text-[56px]">
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #ff7a3d 0%, #ff5722 50%, #e84e5c 100%)' }}
            >
              markets
            </span>
          </span>
        </h1>
        <p className="mt-4 text-[15px] text-[var(--color-text-dim)] max-w-xl mx-auto leading-relaxed">
          Trade on real-world outcomes. Describe your bet in plain English — the agent places it via Polymarket CLOB.
        </p>
      </section>

      {/* ─── Arb analyst (SSE stream) ───────────────────────────── */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 pb-8">
        <ArbAnalystPanel />
      </section>

      {/* ─── Open positions ─────────────────────────────────────── */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 pb-10">
        <PredictionPositions />
      </section>

      {/* ─── Markets ────────────────────────────────────────────── */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 lg:px-8 pb-24">
        <div className="mb-8 text-center">
          <div className="label mb-2" style={{ color: 'var(--color-accent)' }}>Markets</div>
          <h2 className="serif text-[36px] md:text-[44px] leading-[1.05] tracking-tight">
            What&apos;s trending
          </h2>
          <p className="mt-2 text-[14px] text-[var(--color-text-dim)]">Live markets from Polymarket</p>
        </div>
        <PredictionMarkets
          walletAddress={walletAddress}
          onConnectWallet={connectWallet}
        />
      </main>

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
          </div>
        </div>
      </footer>
    </div>
  );
}
