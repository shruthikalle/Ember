'use client';

import { useState, useCallback, useEffect } from 'react';
import MemecoinLeaderboard from '@/src/components/MemecoinLeaderboard';
import MemecoinHoldings from '@/src/components/MemecoinHoldings';

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MemecoinsPage() {
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
    // Try Phantom Solana first for this page
    const solana = (window as any).solana;
    if (solana?.isPhantom) {
      try {
        await solana.connect();
        const addr: string = solana.publicKey.toString();
        setWalletAddress(addr);
        return addr;
      } catch { /* fall through */ }
    }
    // Fallback: EVM wallet
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
      {/* ─── Top nav ────────────────────────────────────────────── */}
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
              <a href="/predictions" className="btn-ghost">Predictions</a>
              <span className="btn-ghost !text-[var(--color-accent)]">Memecoins</span>
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

      {/* ─── Hero ───────────────────────────────────────────────── */}
      <section className="relative z-10 text-center max-w-3xl mx-auto px-6 pt-10 pb-8">
        <div className="inline-flex items-center gap-2 pill pill-accent mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ff7a3d] pulse-dot" />
          Powered by Birdeye + Jupiter
        </div>
        <h1 className="text-[36px] md:text-[48px] leading-[1.05] tracking-[-0.03em] font-normal">
          Solana
          <br />
          <span className="serif italic text-[42px] md:text-[56px]">
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: 'linear-gradient(135deg, #ff7a3d 0%, #ff5722 50%, #e84e5c 100%)' }}
            >
              memecoins
            </span>
          </span>
        </h1>
        <p className="mt-4 text-[15px] text-[var(--color-text-dim)] max-w-xl mx-auto leading-relaxed">
          Track whale activity, security signals, and community predictions on the hottest Solana tokens.
        </p>
      </section>

      {/* ─── Holdings ───────────────────────────────────────────── */}
      <div className="relative z-10 max-w-6xl mx-auto px-6 lg:px-8">
        <MemecoinHoldings walletAddress={walletAddress} onConnectWallet={connectWallet} />
      </div>

      {/* ─── Leaderboard ────────────────────────────────────────── */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 lg:px-8 pb-24">
        <MemecoinLeaderboard walletAddress={walletAddress} onConnectWallet={connectWallet} />
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
            <a href="/predictions" className="hover:text-[var(--color-text)] transition-colors">Predictions</a>
            <a href="/memecoins" className="hover:text-[var(--color-text)] transition-colors">Memecoins</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
