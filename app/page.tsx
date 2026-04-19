'use client';

import { useEffect, useState, useCallback } from 'react';
import TryItWidget from '@/src/components/TryItWidget';
import RecentTables from '@/src/components/RecentTables';
import PortfolioView from '@/src/components/PortfolioView';
import { DottedSurface } from '@/src/components/DottedSurface';
import WalletPicker from '@/src/components/WalletPicker';
import {
  requestEvmProviders,
  getDetectedEvmProviders,
  rememberEvmProvider,
  getLegacyEthereumProvider,
  type EIP6963ProviderDetail,
} from '@/src/lib/evmProvider';

interface Stats {
  agent_address: string;
  explorer_url: string;
  balances: { eth: string; usdc: string };
  totals: {
    gas_spend_usd: number;
    compute_spend_usd: number;
    net_profit_usd: number;
    trade_count: number;
    failed_trade_count: number;
  };
  recent_trades: any[];
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) return;
      const data: Stats = await res.json();
      setStats(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchStats();
    const t = setInterval(fetchStats, 15_000);
    return () => clearInterval(t);
  }, [fetchStats]);

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).ethereum) return;
    const eth = (window as any).ethereum;
    eth.request({ method: 'eth_accounts' }).then((a: string[]) => {
      if (a[0]) setWalletAddress(a[0]);
    }).catch(() => {});
    const handler = (accounts: string[]) => setWalletAddress(accounts[0] || null);
    eth.on?.('accountsChanged', handler);
    return () => eth.removeListener?.('accountsChanged', handler);
  }, []);

  // ── User wallet balances across multiple chains + prices ──
  const [userBalances, setUserBalances] = useState<{
    eth: number;        // Base
    usdc: number;       // Base USDC
    pol: number;        // Polygon native (POL/MATIC)
    polUsdc: number;    // Polygon USDC
    hype: number;       // HyperEVM native
    sol: number | null; // null = no Solana wallet detected
    solUsdc: number;    // Solana SPL USDC
    solAddress: string | null;
  }>({ eth: 0, usdc: 0, pol: 0, polUsdc: 0, hype: 0, sol: null, solUsdc: 0, solAddress: null });

  const [prices, setPrices] = useState<{ eth: number; sol: number; pol: number; hype: number }>({
    eth: 3000, sol: 150, pol: 0.50, hype: 25,
  });

  // Fetch token prices from Coinbase (CORS-friendly). HYPE isn't on Coinbase
  // so we leave the fallback in place for it.
  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const [ethRes, solRes, polRes] = await Promise.all([
          fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot').then((r) => r.json()),
          fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot').then((r) => r.json()),
          fetch('https://api.coinbase.com/v2/prices/POL-USD/spot').then((r) => r.json()).catch(() => null),
        ]);
        setPrices((p) => ({
          ...p,
          eth: parseFloat(ethRes?.data?.amount) || p.eth,
          sol: parseFloat(solRes?.data?.amount) || p.sol,
          pol: parseFloat(polRes?.data?.amount) || p.pol,
        }));
      } catch { /* keep fallback */ }
    };
    fetchPrices();
    const t = setInterval(fetchPrices, 60_000);
    return () => clearInterval(t);
  }, []);

  // Fetch user's EVM balances across Base, Polygon, and HyperEVM
  useEffect(() => {
    if (!walletAddress) {
      setUserBalances((b) => ({ ...b, eth: 0, usdc: 0, pol: 0, polUsdc: 0, hype: 0 }));
      return;
    }

    // Each chain: native + (optional) USDC contract
    const CHAINS = [
      {
        key: 'base' as const,
        rpc: 'https://mainnet.base.org',
        chainId: 8453,
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        nativeField: 'eth' as const,
        usdcField: 'usdc' as const,
      },
      {
        key: 'polygon' as const,
        rpc: 'https://polygon-bor-rpc.publicnode.com',
        chainId: 137,
        usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Circle native USDC on Polygon
        nativeField: 'pol' as const,
        usdcField: 'polUsdc' as const,
      },
      {
        key: 'hyperevm' as const,
        rpc: 'https://rpc.hyperliquid.xyz/evm',
        chainId: 999,
        usdc: undefined,
        nativeField: 'hype' as const,
        usdcField: undefined,
      },
    ];

    const fetchAll = async () => {
      const { ethers } = await import('ethers');
      await Promise.all(
        CHAINS.map(async (c) => {
          try {
            const provider = new ethers.JsonRpcProvider(c.rpc, c.chainId);
            const nativePromise = provider.getBalance(walletAddress);
            const usdcPromise = c.usdc
              ? (new ethers.Contract(
                  c.usdc,
                  ['function balanceOf(address) view returns (uint256)'],
                  provider,
                ).balanceOf(walletAddress) as Promise<bigint>)
              : Promise.resolve(0n);

            const [nativeWei, usdcRaw] = await Promise.all([nativePromise, usdcPromise]);

            setUserBalances((b) => ({
              ...b,
              [c.nativeField]: parseFloat(ethers.formatEther(nativeWei)),
              ...(c.usdcField ? { [c.usdcField]: parseFloat(ethers.formatUnits(usdcRaw, 6)) } : {}),
            }));
          } catch (err) {
            console.warn(`[Portfolio] ${c.key} balance fetch failed:`, err instanceof Error ? err.message : err);
          }
        }),
      );
    };
    fetchAll();
    const t = setInterval(fetchAll, 30_000);
    return () => clearInterval(t);
  }, [walletAddress]);

  // Fetch SOL balance via our own backend proxy — public Solana RPCs block
  // browser origin requests, so we route through Next.js server-side.
  // Always sets sol to AT LEAST 0 once we have a publicKey, so the SOL row
  // appears in the UI even if the upstream RPC is slow.
  const fetchSolBalance = useCallback(async (addr: string) => {
    // Optimistic state — show the connected SOL address with 0 balance immediately
    setUserBalances((b) => ({
      ...b,
      sol: b.solAddress === addr && b.sol !== null ? b.sol : 0,
      solAddress: addr,
    }));

    try {
      const res = await fetch(`/api/sol-balance?address=${encodeURIComponent(addr)}`);
      const data = await res.json();
      if (typeof data?.sol === 'number') {
        console.log(`[Portfolio] SOL: ${data.sol}, Solana USDC: ${data.usdc} via ${data.source}`);
        setUserBalances((b) => ({
          ...b,
          sol: data.sol,
          solUsdc: typeof data.usdc === 'number' ? data.usdc : 0,
          solAddress: addr,
        }));
      } else {
        console.warn('[Portfolio] SOL balance proxy failed:', data?.error);
      }
    } catch (err) {
      console.warn('[Portfolio] SOL balance proxy threw:', err);
    }
  }, []);

  // Try silent Phantom Solana connect on mount (works if user has previously
  // approved this site for Solana in Phantom)
  useEffect(() => {
    const sol = (window as any)?.phantom?.solana || (window as any)?.solana;
    if (!sol) return;
    (async () => {
      try {
        const resp = await sol.connect({ onlyIfTrusted: true });
        const pk = resp?.publicKey || sol.publicKey;
        if (pk) await fetchSolBalance(pk.toString());
      } catch { /* user hasn't trusted this site yet — wait for explicit click */ }
    })();
  }, [fetchSolBalance]);

  // Auto-refresh SOL balance every 30s if connected
  useEffect(() => {
    if (!userBalances.solAddress) return;
    const t = setInterval(() => fetchSolBalance(userBalances.solAddress!), 30_000);
    return () => clearInterval(t);
  }, [userBalances.solAddress, fetchSolBalance]);

  // Explicit Phantom Solana connect — triggered by clicking the SOL row
  const [solConnectError, setSolConnectError] = useState<string | null>(null);
  const connectPhantomSolana = useCallback(async () => {
    setSolConnectError(null);
    const sol = (window as any)?.phantom?.solana || (window as any)?.solana;
    console.log('[Portfolio] Phantom Solana provider:', sol);
    if (!sol) {
      const msg = 'Phantom Solana provider not detected. Make sure Phantom is installed and enabled.';
      console.warn('[Portfolio]', msg);
      setSolConnectError(msg);
      return;
    }
    try {
      console.log('[Portfolio] Calling sol.connect()…');
      const resp = await sol.connect();
      console.log('[Portfolio] Phantom Solana connect response:', resp);
      const pk = resp?.publicKey || sol.publicKey;
      if (!pk) {
        setSolConnectError('Phantom returned no publicKey. Try disconnecting + reconnecting Phantom.');
        return;
      }
      await fetchSolBalance(pk.toString());
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn('[Portfolio] Phantom Solana connect rejected:', err);
      setSolConnectError(msg);
    }
  }, [fetchSolBalance]);

  const ethUsd = userBalances.eth * prices.eth;
  const usdcBaseUsd = userBalances.usdc;
  const usdcSolUsd = userBalances.solUsdc;
  const usdcPolUsd = userBalances.polUsdc;
  const solUsd = (userBalances.sol ?? 0) * prices.sol;
  const polUsd = userBalances.pol * prices.pol;
  const hypeUsd = userBalances.hype * prices.hype;
  const totalUsd = ethUsd + usdcBaseUsd + usdcSolUsd + usdcPolUsd + solUsd + polUsd + hypeUsd;
  const totalUsdcUsd = usdcBaseUsd + usdcSolUsd + usdcPolUsd;

  const explorerBase = stats?.explorer_url
    ? stats.explorer_url.replace(/\/address\/.*$/, '')
    : 'https://basescan.org';

  const netProfit = stats?.totals.net_profit_usd ?? 0;
  const tradeCount = stats?.totals.trade_count ?? 0;
  const failedCount = stats?.totals.failed_trade_count ?? 0;
  const successRate = tradeCount > 0 ? ((tradeCount - failedCount) / tradeCount) * 100 : 0;
  // Gauge fill — use success rate % (0-100). Circumference math in the SVG.

  return (
    <div className="relative min-h-screen" style={{ background: '#09090b' }}>
      {/* ── Animated backdrop ──────────────────────────────────── */}
      <DottedSurface />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[1200px] h-[800px] pointer-events-none -z-[5]"
        style={{ background: 'radial-gradient(ellipse at center, rgba(168,85,247,0.18) 0%, rgba(236,72,153,0.10) 30%, transparent 65%)' }}
      />
      <div className="fixed inset-0 pointer-events-none -z-[3]"
        style={{ background: 'linear-gradient(to bottom, transparent 0%, transparent 50%, rgba(9,9,11,0.75) 85%, rgba(9,9,11,0.97) 100%)' }}
      />

      {/* ═════════════ SIDEBAR (fixed left) ═════════════ */}
      <aside className="hidden lg:flex fixed top-0 left-0 bottom-0 w-[240px] flex-col border-r border-white/[0.06] bg-[#0a0a0d]/80 backdrop-blur-xl z-40">
        <div className="p-6">
          <div className="mb-10">
            <div className="text-[18px] font-black tracking-[0.18em] text-white">EMBER</div>
            <div className="text-[11px] tracking-[0.12em] mt-0.5">
              <span style={{ color: '#ff7a3d' }}>YOU</span>
              <span className="text-white"> THINK. </span>
              <span style={{ color: '#ff7a3d' }}>WE</span>
              <span className="text-white"> TRADE</span>
            </div>
          </div>

          <nav className="space-y-1">
            <SidebarItem icon={<IconHome />} label="Home" active />
            <SidebarItem icon={<IconSwap />} label="Swap" href="#try-it" />
            <SidebarItem icon={<IconPerps />} label="Perps" href="/perps" />
            <SidebarItem icon={<IconPredictions />} label="Predictions" href="/predictions" />
            <SidebarItem icon={<IconMemecoins />} label="Memecoins" href="/memecoins" />
            <SidebarItem icon={<IconEarn />} label="Earn" href="/earn" />
            <SidebarItem icon={<IconActivity />} label="Activity" href="#activity" />
          </nav>
        </div>

        <div className="mt-auto p-6 space-y-4">
          <div className="space-y-1">
            <SidebarItem icon={<IconSettings />} label="Settings" small />
            <SidebarItem icon={<IconHelp />} label="Help" small />
          </div>

          {/* Network status — styled like the inspiration's upload/download meters */}
          <div className="pt-4 border-t border-white/[0.06]">
            <MetricLine label="Base" value="Live" color="#4ade80" />
            <MetricLine label="Hyperliquid" value="Live" color="#4ade80" />
          </div>
        </div>
      </aside>

      {/* ═════════════ MAIN ═════════════ */}
      <div className="lg:pl-[240px] min-h-screen relative">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#09090b]/70 backdrop-blur-2xl">
          <div className="px-6 lg:px-10 py-4 flex items-center gap-4">
            {/* Mobile logo */}
            <div className="lg:hidden flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#ff7a3d] flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <span className="text-[14px] font-black tracking-[0.15em]">EMBER</span>
            </div>

            {/* Command input */}
            <div className="flex-1 max-w-2xl relative">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder="Type a trade or ask the agent…"
                className="w-full bg-white/[0.03] border border-white/[0.06] rounded-full pl-11 pr-4 py-3 text-[13px] text-white placeholder:text-white/30 focus:outline-none focus:border-[#ff7a3d]/40 focus:bg-white/[0.05] transition-all"
              />
            </div>

            <div className="flex items-center gap-3">
              <button className="w-10 h-10 rounded-full border border-white/[0.06] hover:bg-white/[0.04] flex items-center justify-center text-white/60 hover:text-white transition-all" title="Dark mode">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </button>
              <button className="w-10 h-10 rounded-full border border-white/[0.06] hover:bg-white/[0.04] flex items-center justify-center text-white/60 hover:text-white transition-all relative" title="Alerts">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
                <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-[#ff7a3d]" />
              </button>
              {/* Always show SOL chip when not connected to Solana — visible
                  whether or not user has connected EVM yet */}
              {userBalances.sol === null && (
                <button
                  onClick={connectPhantomSolana}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[11px] font-semibold border border-[#14f195]/40 text-[#14f195] hover:bg-[#14f195]/10 transition-all"
                  title="Connect your Solana wallet (Phantom)"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[#14f195]" />
                  + Solana
                </button>
              )}

              {walletAddress ? (
                <a href={stats?.explorer_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 pl-3 pr-1 py-1 rounded-full border border-white/[0.06] hover:border-white/[0.12] transition-colors">
                  <span className="text-[12px] font-mono text-white/70">{walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</span>
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#a855f7] via-[#ec4899] to-[#ff7a3d] flex items-center justify-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </div>
                </a>
              ) : (
                <ConnectButton
                  onConnect={(addr) => setWalletAddress(addr)}
                  onConnectSol={connectPhantomSolana}
                />
              )}

              {/* Inline error if Phantom Solana failed */}
              {solConnectError && (
                <span className="hidden md:block text-[10px] text-red-300/80 max-w-[200px] truncate" title={solConnectError}>
                  {solConnectError}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* ── HERO ──────────────────────────────────────────── */}
        <section className="relative px-6 lg:px-10 pt-10 lg:pt-16 pb-20">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-10 xl:gap-12 relative z-10">
            {/* Left: kicker + headline + widget + subline */}
            <div className="min-w-0">
              <p className="text-[13px] text-white/45 mb-6">Natural-language trading for onchain markets</p>

              <h1 className="text-[44px] md:text-[64px] xl:text-[76px] font-black leading-[0.95] tracking-[-0.02em] uppercase">
                <span className="block text-white">TRADE AT THE</span>
                <span className="block text-white">
                  <InlineIcon type="bolt" /> SPEED OF
                </span>
                <span className="block text-[#ff7a3d]">THOUGHT</span>
              </h1>

              {/* Swap widget — the product */}
              <div id="try-it" className="mt-10 max-w-2xl relative scroll-mt-28">
                <TryItWidget />
              </div>

              {/* Chains subline */}
              <div className="mt-8 flex items-center gap-3 text-[13px] text-white/50">
                <div className="w-9 h-9 rounded-full border border-white/[0.08] flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <ellipse cx="12" cy="12" rx="4" ry="10" />
                    <path d="M2 12h20" />
                  </svg>
                </div>
                <span>One chat across <span className="text-white/80">Base, Solana, Hyperliquid, and Polymarket</span>.</span>
              </div>

              {/* ── HOW IT WORKS (inline, below widget) ───────── */}
              <div className="mt-12 max-w-xl">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#ff7a3d]/70 mb-4">How it works</p>
                <div className="relative">
                  <div className="absolute left-[15px] top-3 bottom-3 w-px bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-transparent" />
                  <div className="space-y-5">
                    {[
                      { title: 'Describe', desc: 'Type what you want in plain English — "Swap $10 ETH to SOL", "Long $5 BTC at 10x", "Bet YES on Fed cut".' },
                      { title: 'Route',    desc: 'The agent finds the best chain, best price, and correct protocol — Uniswap, Jupiter, Hyperliquid, or Polymarket.' },
                      { title: 'Sign',     desc: 'Review the full transaction in your wallet. Nothing moves until you click approve.' },
                      { title: 'Settled',  desc: 'Lands onchain, tagged with ERC-8021 builder code, visible on the explorer.' },
                    ].map((s, i) => (
                      <div key={s.title} className="relative flex gap-4 items-start">
                        <div className="relative z-10 w-8 h-8 rounded-full border border-white/[0.08] bg-[#09090b] flex items-center justify-center text-[11px] font-mono text-white/60 flex-shrink-0">
                          {String(i + 1).padStart(2, '0')}
                        </div>
                        <div className="pt-1">
                          <p className="text-[13px] font-semibold text-white tracking-tight">{s.title}</p>
                          <p className="text-[12px] text-white/40 leading-[1.55] mt-0.5">{s.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: live portfolio (reusable component, same data as /portfolio) */}
            <div className="xl:sticky xl:top-24 h-fit">
              <PortfolioView />
            </div>
          </div>
        </section>

        {/* ── PRODUCT SHOWCASE ─────────────────────────────── */}
        <section id="products" className="relative px-6 lg:px-10 py-20 border-t border-white/[0.04]">
          <div className="max-w-6xl">
            <p className="text-[11px] uppercase tracking-[0.18em] text-[#ff7a3d]/70 mb-3">What you can trade</p>
            <h2 className="text-[32px] md:text-[42px] font-black tracking-[-0.02em] text-white mb-3">
              One agent. Three markets.
            </h2>
            <p className="text-[15px] text-white/50 max-w-2xl mb-12">
              Spot swaps, leveraged perps, and prediction markets — all from the same chat window.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {/* Swap */}
              <ShowcaseCard
                icon={
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 10h14l-4-4" />
                    <path d="M17 14H3l4 4" />
                  </svg>
                }
                title="Swap"
                tagline="Best-route swaps across Base and Solana — Uniswap and Jupiter under one chat."
                example={'"Swap $10 ETH to SOL"'}
                response="→ Swapped at best rate across chains"
                poweredBy={['Uniswap', 'Jupiter']}
              />

              {/* Perps */}
              <ShowcaseCard
                icon={
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3v18h18" />
                    <path d="M7 14l4-4 4 4 5-6" />
                  </svg>
                }
                title="Perps"
                tagline="Long or short any asset with up to 50x leverage, executed on Hyperliquid."
                example={'"Long $5 BTC at 10x"'}
                response="→ Position opened on Hyperliquid"
                poweredBy={['Hyperliquid']}
                accent
              />

              {/* Predict */}
              <ShowcaseCard
                icon={
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                }
                title="Predict"
                tagline="Bet on real-world outcomes — elections, crypto, sports, macro — via Polymarket."
                example={'"Bet $2 YES on Fed rate cut"'}
                response="→ 0.62 YES shares at 58¢"
                poweredBy={['Polymarket']}
              />
            </div>

            {/* Powered by strip */}
            <div className="mt-14 pt-8 border-t border-white/[0.04]">
              <p className="text-[11px] uppercase tracking-[0.18em] text-white/30 mb-5">Powered by</p>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-4 text-[13px] text-white/40">
                <span className="hover:text-white/70 transition-colors">Uniswap</span>
                <span className="text-white/10">·</span>
                <span className="hover:text-white/70 transition-colors">Jupiter</span>
                <span className="text-white/10">·</span>
                <span className="hover:text-white/70 transition-colors">Hyperliquid</span>
                <span className="text-white/10">·</span>
                <span className="hover:text-white/70 transition-colors">Polymarket</span>
                <span className="text-white/10">·</span>
                <span className="hover:text-white/70 transition-colors">Base</span>
                <span className="text-white/10">·</span>
                <span className="hover:text-white/70 transition-colors">Solana</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── ACTIVITY ─────────────────────────────────────── */}
        {stats && stats.recent_trades.length > 0 && (
          <section id="activity" className="relative px-6 lg:px-10 pb-20">
            <div className="max-w-5xl">
              <RecentTables trades={stats.recent_trades} explorerBase={explorerBase} />
            </div>
          </section>
        )}

        {loading && (
          <div className="px-6 lg:px-10 pb-16 flex items-center justify-center">
            <div className="flex items-center gap-3 text-white/40 text-[13px]">
              <div className="w-4 h-4 border-2 border-white/10 border-t-[#ff7a3d] rounded-full animate-spin" />
              Loading…
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────

function SidebarItem({ icon, label, active, href, small }: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  href?: string;
  small?: boolean;
}) {
  const Tag = href ? 'a' : 'div';
  return (
    <Tag
      href={href}
      className={`flex items-center gap-3 px-3 ${small ? 'py-2' : 'py-2.5'} rounded-lg text-[13px] cursor-pointer transition-all ${
        active
          ? 'text-white bg-white/[0.05] border border-white/[0.06] relative'
          : 'text-white/50 hover:text-white hover:bg-white/[0.04]'
      }`}
    >
      {active && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-[#ff7a3d]" />
      )}
      <span className={active ? 'text-white' : 'text-white/40'}>{icon}</span>
      <span>{label}</span>
    </Tag>
  );
}

function MetricLine({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[10px] text-white/35 tracking-wide uppercase">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: color }} />
        <span className="text-[11px] font-semibold" style={{ color }}>{value}</span>
      </div>
    </div>
  );
}

// ─── Sidebar icons ───────────────────────────────────────────

const iconCls = 'w-4 h-4';
function IconHome() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12l9-9 9 9" /><path d="M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" /></svg>); }
function IconSwap() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 014-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 01-4 4H3" /></svg>); }
function IconPerps() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>); }
function IconPredictions() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>); }
function IconMemecoins() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>); }
function IconAssets() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /><line x1="12" y1="12" x2="12" y2="16" /><line x1="10" y1="14" x2="14" y2="14" /></svg>); }
function IconActivity() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>); }
function IconPortfolio() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2M2 13h20" /></svg>); }
function IconEarn() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></svg>); }
function IconSettings() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>); }
function IconHelp() { return (<svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>); }

// ─── Hero inline icons ───────────────────────────────────────

function InlineIcon({ type }: { type: 'bolt' | 'lock' }) {
  const size = 52;
  if (type === 'bolt') {
    return (
      <span className="inline-flex items-center justify-center align-middle rounded-[12px] mx-2"
        style={{ width: size, height: size, background: 'linear-gradient(135deg, rgba(255,209,102,0.15), rgba(255,122,61,0.15))', border: '1px solid rgba(255,122,61,0.25)' }}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="#ff7a3d" stroke="#ff7a3d" strokeWidth="1.5">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center align-middle rounded-[12px] mx-2"
      style={{ width: size, height: size, background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(236,72,153,0.15))', border: '1px solid rgba(168,85,247,0.25)' }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
    </span>
  );
}

// ─── Portfolio card bits ─────────────────────────────────────

// Multi-segment donut chart — each token gets a colored arc proportional to its
// share of total wallet value. Ring is empty (just a track) when wallet is empty.
function AllocationDonut({ segments, centerLabel, centerSublabel }: {
  segments: Array<{ value: number; color: string; label: string }>;
  centerLabel: string;
  centerSublabel: string;
}) {
  const R = 88;
  const CIRC = 2 * Math.PI * R;
  const total = segments.reduce((s, x) => s + x.value, 0);
  const GAP = total > 0 ? 4 : 0; // px gap between segments

  let cumulative = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / total;
      const length = Math.max(0, frac * CIRC - GAP);
      const start = (cumulative / total) * CIRC;
      cumulative += s.value;
      return { ...s, length, start };
    });

  return (
    <div className="relative flex items-center justify-center py-2">
      <svg width="220" height="220" viewBox="0 0 220 220" className="-rotate-90">
        {/* Track */}
        <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="10" />
        {/* Segments */}
        {arcs.map((a, i) => (
          <circle
            key={a.label + i}
            cx="110" cy="110" r={R}
            fill="none"
            stroke={a.color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${a.length} ${CIRC}`}
            strokeDashoffset={-a.start}
            style={{
              filter: `drop-shadow(0 0 6px ${a.color}55)`,
              transition: 'stroke-dasharray 600ms ease, stroke-dashoffset 600ms ease',
            }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <div className="text-[34px] font-black text-white tracking-tight tabular-nums leading-none">{centerLabel}</div>
        <div className="text-[10px] text-white/40 mt-2 tracking-[0.18em] uppercase">{centerSublabel}</div>
      </div>
    </div>
  );
}

function DonutLegend({ segments }: {
  segments: Array<{ value: number; color: string; label: string }>;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;
  const rows = segments.filter((s) => s.value > 0);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-2">
      {rows.map((s) => (
        <div key={s.label} className="flex items-center justify-between text-[11px]">
          <span className="inline-flex items-center gap-1.5 text-white/70">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="font-semibold text-white/90 tabular-nums">
            {Math.round((s.value / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function CircularGauge({ value, max, label, sublabel, positive }: {
  value: number; max: number; label: string; sublabel: string; positive: boolean;
}) {
  const R = 88;
  const CIRC = 2 * Math.PI * R;
  const pct = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  const offset = CIRC - (pct / 100) * CIRC;
  const color = positive ? '#ffd166' : '#fb7185';

  return (
    <div className="relative flex items-center justify-center py-2">
      <svg width="220" height="220" viewBox="0 0 220 220" className="-rotate-90">
        {/* Track */}
        <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="10" />
        {/* Progress */}
        <circle
          cx="110" cy="110" r={R}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          style={{ filter: `drop-shadow(0 0 10px ${color}66)`, transition: 'stroke-dashoffset 600ms ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="text-[28px] font-black text-white tracking-tight tabular-nums">{label}</div>
        <div className="text-[11px] text-white/40 mt-1">{sublabel}</div>
      </div>
    </div>
  );
}

function BreakdownRow({ icon, label, sub, value, dotColor, pct }: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  value: string;
  dotColor?: string;
  pct?: number;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="relative w-8 h-8 rounded-lg bg-white/[0.03] border border-white/[0.05] flex items-center justify-center text-white/60 flex-shrink-0">
        {icon}
        {dotColor && (
          <span
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-[#0a0a0d]"
            style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}88` }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-white truncate">{label}</p>
        <p className="text-[10px] text-white/35 truncate">{sub}</p>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="text-[12px] font-semibold text-white/90 tabular-nums leading-none">{value}</p>
        {pct !== undefined && pct > 0 && (
          <p className="text-[10px] mt-1 tabular-nums" style={{ color: dotColor || 'rgba(255,255,255,0.4)' }}>
            {pct < 1 ? '<1' : Math.round(pct)}%
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Wallet panel — expandable card with addresses, copy, explorers ──

function WalletPanel({ evmAddress, solAddress }: { evmAddress: string; solAddress: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (val: string, key: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative w-full rounded-2xl py-3.5 text-[12px] font-black tracking-[0.12em] uppercase text-black overflow-hidden flex items-center justify-center gap-2 cursor-pointer hover:brightness-110 active:brightness-95 transition-all"
        style={{ background: 'linear-gradient(135deg, #ffd166 0%, #ff7a3d 100%)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="pointer-events-none">
          <rect x="2" y="6" width="20" height="14" rx="3" />
          <path d="M16 13h.01M2 10h20" />
        </svg>
        <span className="pointer-events-none">{open ? 'CLOSE WALLET' : 'OPEN WALLET'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`pointer-events-none transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="rounded-2xl border border-white/[0.08] bg-black/40 backdrop-blur-md p-3 space-y-3">
          {/* EVM address */}
          <div>
            <p className="text-[9px] font-bold tracking-[0.18em] text-white/40 mb-1.5">EVM ADDRESS</p>
            <div className="flex items-center gap-2 bg-white/[0.03] rounded-lg px-2.5 py-2 border border-white/[0.05]">
              <span className="text-[11px] font-mono text-white/85 truncate flex-1">{evmAddress}</span>
              <button
                type="button"
                onClick={() => copy(evmAddress, 'evm')}
                className="text-[10px] font-bold text-white/60 hover:text-white px-2 py-1 rounded hover:bg-white/[0.08] transition-all"
              >
                {copied === 'evm' ? 'COPIED' : 'COPY'}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              <a href={`https://basescan.org/address/${evmAddress}`} target="_blank" rel="noopener noreferrer"
                className="text-center text-[9px] font-semibold uppercase tracking-wider text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.05] rounded-md py-1.5 transition-all">
                Base ↗
              </a>
              <a href={`https://polygonscan.com/address/${evmAddress}`} target="_blank" rel="noopener noreferrer"
                className="text-center text-[9px] font-semibold uppercase tracking-wider text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.05] rounded-md py-1.5 transition-all">
                Polygon ↗
              </a>
              <a href={`https://etherscan.io/address/${evmAddress}`} target="_blank" rel="noopener noreferrer"
                className="text-center text-[9px] font-semibold uppercase tracking-wider text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.05] rounded-md py-1.5 transition-all">
                ETH ↗
              </a>
            </div>
          </div>

          {/* Solana address */}
          {solAddress && (
            <div className="pt-2 border-t border-white/[0.05]">
              <p className="text-[9px] font-bold tracking-[0.18em] text-white/40 mb-1.5">SOLANA ADDRESS</p>
              <div className="flex items-center gap-2 bg-white/[0.03] rounded-lg px-2.5 py-2 border border-white/[0.05]">
                <span className="text-[11px] font-mono text-white/85 truncate flex-1">{solAddress}</span>
                <button
                  type="button"
                  onClick={() => copy(solAddress, 'sol')}
                  className="text-[10px] font-bold text-white/60 hover:text-white px-2 py-1 rounded hover:bg-white/[0.08] transition-all"
                >
                  {copied === 'sol' ? 'COPIED' : 'COPY'}
                </button>
              </div>
              <a href={`https://solscan.io/account/${solAddress}`} target="_blank" rel="noopener noreferrer"
                className="block text-center text-[9px] font-semibold uppercase tracking-wider text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.05] rounded-md py-1.5 mt-2 transition-all">
                View on Solscan ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TokenIcon({ symbol }: { symbol: string }) {
  const config: Record<string, { bg: string; glyph: string }> = {
    ETH:  { bg: 'linear-gradient(135deg, #627eea, #3c5bd0)', glyph: 'Ξ' },
    USDC: { bg: 'linear-gradient(135deg, #2775ca, #1b5aa3)', glyph: '$' },
    SOL:  { bg: 'linear-gradient(135deg, #14f195, #9945ff)', glyph: 'S' },
    POL:  { bg: 'linear-gradient(135deg, #a855f7, #6d28d9)', glyph: 'P' },
    HYPE: { bg: 'linear-gradient(135deg, #06b6d4, #0e7490)', glyph: 'H' },
  };
  const c = config[symbol] || { bg: 'linear-gradient(135deg, #a855f7, #ec4899)', glyph: symbol.slice(0, 1) };
  return (
    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-black text-white"
      style={{ background: c.bg }}>
      {c.glyph}
    </div>
  );
}

function IconTrades() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>); }
function IconGas() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>); }

// ─── Connect button — EIP-6963 picker + Phantom Solana ───────

function ConnectButton({
  onConnect,
  onConnectSol,
}: {
  onConnect: (addr: string) => void;
  onConnectSol: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [providers, setProviders] = useState<EIP6963ProviderDetail[]>([]);

  // Keep a live list of EIP-6963 providers. Read-only sync — no re-dispatch
  // in the announce handler (avoids the announce→dispatch feedback loop).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setProviders(getDetectedEvmProviders());
    const onAnnounce = () => sync();
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    requestEvmProviders();
    sync();
    const timers = [100, 400, 1500].map((ms) =>
      window.setTimeout(() => { requestEvmProviders(); sync(); }, ms),
    );
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  const connectWith = useCallback(async (detail: EIP6963ProviderDetail) => {
    setPickerOpen(false);
    setBusy(true);
    try {
      try {
        const accounts: string[] = await detail.provider.request({ method: 'eth_requestAccounts' });
        if (accounts[0]) {
          onConnect(accounts[0]);
          rememberEvmProvider(detail.info.rdns);
        }
      } catch { /* user rejected EVM */ }
      try { await onConnectSol(); } catch { /* user rejected SOL */ }
    } finally {
      setBusy(false);
    }
  }, [onConnect, onConnectSol]);

  const handleClick = useCallback(async () => {
    if (typeof window === 'undefined') return;
    // One-off dispatch to catch any late-announcing wallets before we decide.
    requestEvmProviders();
    const list = getDetectedEvmProviders();
    if (list.length > 1) {
      setProviders(list);
      setPickerOpen(true);
      return;
    }
    if (list.length === 1) {
      return connectWith(list[0]);
    }
    // No 6963 provider — fall back to legacy window.ethereum if available.
    setBusy(true);
    try {
      const eth = getLegacyEthereumProvider();
      if (eth) {
        try {
          const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
          if (accounts[0]) onConnect(accounts[0]);
        } catch { /* user rejected EVM */ }
      }
      try { await onConnectSol(); } catch { /* user rejected SOL */ }
    } finally {
      setBusy(false);
    }
  }, [connectWith, onConnect, onConnectSol]);

  return (
    <>
      <button
        onClick={handleClick}
        disabled={busy}
        className="px-4 py-2 rounded-full text-[12px] font-bold text-black disabled:opacity-60"
        style={{ background: 'linear-gradient(135deg, #ffd166 0%, #ff7a3d 100%)' }}
      >
        {busy ? 'Connecting…' : 'Connect Wallet'}
      </button>
      <WalletPicker
        open={pickerOpen}
        providers={providers}
        onPick={connectWith}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

// ─── Product Showcase card ──────────────────────────────────
function ShowcaseCard({
  icon,
  title,
  tagline,
  example,
  response,
  poweredBy,
  accent = false,
}: {
  icon: React.ReactNode;
  title: string;
  tagline: string;
  example: string;
  response: string;
  poweredBy: string[];
  accent?: boolean;
}) {
  return (
    <a
      href="#try-it"
      className={`group relative block rounded-2xl p-6 border transition-all overflow-hidden ${
        accent
          ? 'border-[#ff7a3d]/25 bg-[#ff7a3d]/[0.03] hover:border-[#ff7a3d]/45 hover:bg-[#ff7a3d]/[0.05]'
          : 'border-white/[0.06] bg-white/[0.015] hover:border-white/[0.12] hover:bg-white/[0.03]'
      }`}
    >
      {/* Soft background glow on hover */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{
          background: accent
            ? 'radial-gradient(400px circle at top right, rgba(255,122,61,0.08), transparent 60%)'
            : 'radial-gradient(400px circle at top right, rgba(255,255,255,0.03), transparent 60%)',
        }}
      />

      <div className="relative">
        {/* Icon */}
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center mb-5 transition-colors ${
            accent
              ? 'bg-[#ff7a3d]/10 text-[#ff7a3d] group-hover:bg-[#ff7a3d]/15'
              : 'bg-white/[0.04] text-white/70 group-hover:bg-white/[0.08] group-hover:text-white'
          }`}
        >
          {icon}
        </div>

        {/* Title */}
        <h3 className="text-[22px] font-bold tracking-tight text-white mb-2">{title}</h3>

        {/* Tagline */}
        <p className="text-[13px] text-white/50 leading-[1.55] mb-5 min-h-[44px]">{tagline}</p>

        {/* Example → Response */}
        <div className="rounded-xl border border-white/[0.05] bg-black/30 p-3 mb-4 font-mono text-[12px] leading-[1.5]">
          <div className="text-white/85">{example}</div>
          <div className={`mt-1 ${accent ? 'text-[#ff7a3d]/80' : 'text-white/35'}`}>{response}</div>
        </div>

        {/* Powered by */}
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-white/25">
          <span>Via</span>
          {poweredBy.map((p, i) => (
            <span key={p} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-white/15">+</span>}
              <span className="text-white/50">{p}</span>
            </span>
          ))}
        </div>

        {/* Arrow */}
        <div className={`absolute top-0 right-0 opacity-0 group-hover:opacity-100 translate-x-1 group-hover:translate-x-0 transition-all ${accent ? 'text-[#ff7a3d]' : 'text-white/60'}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 17L17 7M17 7H8M17 7v9" />
          </svg>
        </div>
      </div>
    </a>
  );
}
