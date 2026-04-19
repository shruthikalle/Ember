'use client';

import PortfolioView from '@/src/components/PortfolioView';

export default function PortfolioPage() {
  return (
    <div className="relative min-h-screen" style={{ background: '#09090b' }}>
      {/* Subtle warm wash anchored at top */}
      <div
        className="fixed top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[600px] pointer-events-none -z-[5]"
        style={{ background: 'radial-gradient(ellipse at center, rgba(255,122,61,0.08) 0%, transparent 70%)' }}
      />

      {/* ── Top nav (matches /perps) ────────────────────────── */}
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
              <span className="btn-ghost !text-[var(--color-accent)]">Portfolio</span>
              <a href="/memecoins" className="btn-ghost">Memecoins</a>
              <a href="/assets" className="btn-ghost">Assets</a>
            </nav>
          </div>
        </div>
      </header>

      {/* ── Hero header ─────────────────────────────────────── */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 lg:px-8 pt-10 pb-10">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[#ff7a3d]/70 mb-3">Your wallet</p>
        <h1 className="text-[40px] md:text-[52px] font-black tracking-[-0.02em] text-white mb-3">
          Portfolio
        </h1>
        <p className="text-[14px] text-white/50 max-w-xl leading-relaxed">
          Live balances across Base, Polygon, HyperEVM, and Solana. Non-custodial — we only read public addresses.
        </p>
      </section>

      {/* ── Portfolio card ──────────────────────────────────── */}
      <main className="relative z-10 max-w-2xl mx-auto px-6 lg:px-8 pb-24">
        <PortfolioView />
      </main>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-[12px] text-white/30">
            <span className="text-white/50 font-medium">ember</span>
            <span>·</span>
            <span>Non-custodial</span>
          </div>
          <div className="flex items-center gap-5 text-[12px] text-white/30">
            <a href="/" className="hover:text-white/60 transition-colors">Home</a>
            <a href="/perps" className="hover:text-white/60 transition-colors">Perps</a>
            <a href="/predictions" className="hover:text-white/60 transition-colors">Predictions</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
