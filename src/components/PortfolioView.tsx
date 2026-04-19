'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  requestEvmProviders,
  getDetectedEvmProviders,
  rememberEvmProvider,
  forgetEvmProvider,
  getRememberedEvmProvider,
  getLegacyEthereumProvider,
  getPhantomSolanaProvider,
  type EIP6963ProviderDetail,
} from '@/src/lib/evmProvider';
import WalletPicker from '@/src/components/WalletPicker';

/**
 * PortfolioView — self-contained portfolio dashboard
 *
 * Renders:
 *   - Allocation donut (multi-chain balances by asset)
 *   - Breakdown rows (per-token values)
 *   - Expandable wallet panel (addresses, explorer links)
 *
 * Handles wallet detection (MetaMask + Phantom Solana), price fetching from
 * Coinbase spot, and multi-chain balance fetching (Base, Polygon, HyperEVM,
 * Solana via backend proxy).
 */

// ─── Utilities ─────────────────────────────────────────────────
export function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PORTFOLIO_DUST_USD = 0.5;

interface SolToken {
  mint: string;
  symbol?: string;
  name?: string;
  logo?: string;
  amount: number;
  decimals: number;
  priceUsd?: number;
  usd?: number;
}

function fmtTokenAmount(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  if (amount >= 1) return amount.toFixed(4);
  return amount.toFixed(6);
}

// ─── Main component ────────────────────────────────────────────
export default function PortfolioView() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<any | null>(null);
  const [evmProviders, setEvmProviders] = useState<EIP6963ProviderDetail[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Discover EIP-6963 EVM wallets (MetaMask, Phantom, Rabby, Coinbase, …).
  // NOTE: the announce handler must NOT re-dispatch `eip6963:requestProvider`
  // (or call anything that does) — that would trap us in an announce→dispatch
  // →announce loop and crash the tab. Read from the already-populated list,
  // and re-request only via explicit timers below.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setEvmProviders(getDetectedEvmProviders());
    const onAnnounce = () => sync();
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    requestEvmProviders();
    sync();
    // Some wallets announce late — re-request a few times after mount.
    const timers = [100, 400, 1500].map((ms) =>
      window.setTimeout(() => { requestEvmProviders(); sync(); }, ms),
    );
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  // Silent reconnect — ONLY if the user previously picked a specific provider
  // via the picker. This avoids the Phantom-EVM-auto-grab bug.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const remembered = getRememberedEvmProvider();
    const eth = remembered?.provider;
    if (!eth) return;
    setActiveProvider(eth);
    eth.request({ method: 'eth_accounts' }).then((a: string[]) => {
      if (a[0]) setWalletAddress(a[0]);
    }).catch(() => {});
    const handler = (accounts: string[]) => setWalletAddress(accounts[0] || null);
    eth.on?.('accountsChanged', handler);
    return () => eth.removeListener?.('accountsChanged', handler);
    // Re-run when the EIP-6963 list changes so we attach as soon as the
    // remembered wallet announces itself.
  }, [evmProviders]);

  // Balances + prices
  const [userBalances, setUserBalances] = useState<{
    eth: number;           // Base-native ETH
    usdc: number;          // Base USDC
    ethMainnet: number;    // Ethereum-mainnet ETH
    usdcMainnet: number;   // Ethereum-mainnet USDC
    pol: number;
    polUsdc: number;
    hype: number;
    hlUsdc: number;        // Hyperliquid L1 USDC (perps + spot clearinghouse)
    sol: number | null;
    solTokens: SolToken[];
    solAddress: string | null;
  }>({ eth: 0, usdc: 0, ethMainnet: 0, usdcMainnet: 0, pol: 0, polUsdc: 0, hype: 0, hlUsdc: 0, sol: null, solTokens: [], solAddress: null });

  const [prices, setPrices] = useState<{ eth: number; sol: number; pol: number; hype: number }>({
    eth: 3000, sol: 150, pol: 0.50, hype: 25,
  });

  // Unified portfolio fetch — one server call covers mainnet, Base,
  // Polygon, HyperEVM, Solana (native + SPL). See /api/portfolio.
  useEffect(() => {
    const evm = walletAddress;
    const sol = userBalances.solAddress;
    if (!evm && !sol) {
      setUserBalances((b) => ({
        ...b,
        eth: 0, usdc: 0, ethMainnet: 0, usdcMainnet: 0, pol: 0, polUsdc: 0, hype: 0, hlUsdc: 0,
        solTokens: [],
      }));
      return;
    }

    let cancelled = false;
    const load = async () => {
      const params = new URLSearchParams();
      if (evm) params.set('evm', evm);
      if (sol) params.set('sol', sol);
      params.set('minUsd', String(PORTFOLIO_DUST_USD));

      try {
        const res = await fetch(`/api/portfolio?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;

        const c = data?.chains ?? {};
        setUserBalances((b) => ({
          ...b,
          eth:         c.base?.native       ?? 0,
          usdc:        c.base?.usdc         ?? 0,
          ethMainnet:  c.mainnet?.native    ?? 0,
          usdcMainnet: c.mainnet?.usdc      ?? 0,
          pol:         c.polygon?.native    ?? 0,
          polUsdc:     c.polygon?.usdc      ?? 0,
          hype:        c.hyperevm?.native   ?? 0,
          hlUsdc:      data?.hyperliquid?.totalUsdc ?? 0,
          sol:         data?.solana?.sol ?? b.sol,
          solTokens:   Array.isArray(data?.solana?.tokens) ? (data.solana.tokens as SolToken[]) : b.solTokens,
        }));
        if (data?.prices) {
          setPrices((p) => ({
            eth:  Number(data.prices.eth)  || p.eth,
            sol:  Number(data.prices.sol)  || p.sol,
            pol:  Number(data.prices.pol)  || p.pol,
            hype: Number(data.prices.hype) || p.hype,
          }));
        }
      } catch (err) {
        console.warn('[Portfolio] /api/portfolio failed:', err instanceof Error ? err.message : err);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress, userBalances.solAddress]);

  // Set the Solana address when Phantom connects — the effect above
  // then picks it up and refetches the unified portfolio.
  const fetchSolBalance = useCallback(async (addr: string) => {
    setUserBalances((b) => ({
      ...b,
      sol: b.solAddress === addr && b.sol !== null ? b.sol : 0,
      solAddress: addr,
    }));
  }, []);

  // Silent Phantom Solana connect on mount — Phantom only, never generic
  // `window.solana` (which could be Solflare/Backpack/Glow).
  useEffect(() => {
    const sol = getPhantomSolanaProvider();
    if (!sol) return;
    (async () => {
      try {
        const resp = await sol.connect({ onlyIfTrusted: true });
        const pk = resp?.publicKey || sol.publicKey;
        if (pk) await fetchSolBalance(pk.toString());
      } catch { /* not trusted yet */ }
    })();
  }, [fetchSolBalance]);

  // Auto-refresh SOL balance
  useEffect(() => {
    if (!userBalances.solAddress) return;
    const t = setInterval(() => fetchSolBalance(userBalances.solAddress!), 30_000);
    return () => clearInterval(t);
  }, [userBalances.solAddress, fetchSolBalance]);

  const [solConnectError, setSolConnectError] = useState<string | null>(null);
  const connectPhantomSolana = useCallback(async () => {
    setSolConnectError(null);
    const sol = getPhantomSolanaProvider();
    if (!sol) {
      setSolConnectError('Phantom not detected. Install Phantom from phantom.com and reload.');
      return;
    }
    try {
      const resp = await sol.connect();
      const pk = resp?.publicKey || sol.publicKey;
      if (!pk) {
        setSolConnectError('Phantom returned no publicKey. Try disconnecting + reconnecting in Phantom.');
        return;
      }
      await fetchSolBalance(pk.toString());
    } catch (err: any) {
      setSolConnectError(err?.message || String(err));
    }
  }, [fetchSolBalance]);

  // Connect with a specific EIP-6963 provider (picked from the picker UI).
  const connectWithProvider = useCallback(async (detail: EIP6963ProviderDetail) => {
    try {
      const accounts: string[] = await detail.provider.request({ method: 'eth_requestAccounts' });
      if (accounts[0]) {
        setWalletAddress(accounts[0]);
        setActiveProvider(detail.provider);
        rememberEvmProvider(detail.info.rdns);
      }
    } catch { /* user rejected */ }
    setPickerOpen(false);
  }, []);

  // Click "Connect" — open the picker if multiple wallets are installed,
  // otherwise connect with the single provider found.
  const connectEvm = useCallback(async () => {
    // One-off dispatch on click to catch any late-announcing wallets, then read.
    requestEvmProviders();
    const list = getDetectedEvmProviders();
    if (list.length > 1) {
      setPickerOpen(true);
      return;
    }
    if (list.length === 1) {
      return connectWithProvider(list[0]);
    }
    // No 6963 provider announced — fall through to legacy window.ethereum.
    const eth = getLegacyEthereumProvider();
    if (!eth) return;
    try {
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      if (accounts[0]) {
        setWalletAddress(accounts[0]);
        setActiveProvider(eth);
      }
    } catch { /* user rejected */ }
  }, [connectWithProvider]);

  // Disconnect — revokes permissions (EIP-2255) and clears state so the next
  // connect prompts fresh and the picker reopens.
  const disconnect = useCallback(async () => {
    try {
      const eth = activeProvider || getLegacyEthereumProvider();
      if (eth?.request) {
        await eth.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        }).catch(() => {});
      }
      const sol = getPhantomSolanaProvider();
      if (sol?.disconnect) await sol.disconnect().catch(() => {});
    } finally {
      forgetEvmProvider();
      setActiveProvider(null);
      setWalletAddress(null);
      setUserBalances({
        eth: 0, usdc: 0, ethMainnet: 0, usdcMainnet: 0,
        pol: 0, polUsdc: 0, hype: 0, hlUsdc: 0,
        sol: null, solTokens: [], solAddress: null,
      });
      setSolConnectError(null);
    }
  }, [activeProvider]);

  // ── USD conversions
  const ethUsd          = userBalances.eth * prices.eth;
  const ethMainnetUsd   = userBalances.ethMainnet * prices.eth;
  const usdcBaseUsd     = userBalances.usdc;
  const usdcMainnetUsd  = userBalances.usdcMainnet;
  const usdcPolUsd      = userBalances.polUsdc;
  const usdcHlUsd       = userBalances.hlUsdc;
  const usdcSolUsd      = userBalances.solTokens.find((t) => t.mint === SOL_USDC_MINT)?.usd ?? 0;
  const splOtherUsd     = userBalances.solTokens
    .filter((t) => t.mint !== SOL_USDC_MINT)
    .reduce((s, t) => s + (t.usd ?? 0), 0);
  const solUsd          = (userBalances.sol ?? 0) * prices.sol;
  const polUsd          = userBalances.pol * prices.pol;
  const hypeUsd         = userBalances.hype * prices.hype;
  const totalEthUsd     = ethUsd + ethMainnetUsd;
  const totalUsd        = ethUsd + ethMainnetUsd + usdcBaseUsd + usdcMainnetUsd + usdcSolUsd + usdcPolUsd + usdcHlUsd + splOtherUsd + solUsd + polUsd + hypeUsd;
  const totalUsdcUsd    = usdcBaseUsd + usdcMainnetUsd + usdcSolUsd + usdcPolUsd + usdcHlUsd;

  // ─── Empty state ────────────────────────────────────────────
  if (!walletAddress) {
    return (
      <>
        <div className="relative rounded-3xl border border-white/[0.08] overflow-hidden p-12 text-center"
          style={{
            background: 'linear-gradient(180deg, rgba(22,22,26,0.55) 0%, rgba(12,12,16,0.70) 100%)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <div className="w-16 h-16 rounded-2xl mx-auto mb-6 bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-white/40">
              <rect x="2" y="6" width="20" height="14" rx="3" />
              <path d="M16 13h.01M2 10h20" />
            </svg>
          </div>
          <h3 className="text-[20px] font-bold tracking-tight text-white mb-2">Connect your wallet</h3>
          <p className="text-[13px] text-white/45 max-w-sm mx-auto mb-6 leading-relaxed">
            Pick any EVM wallet (MetaMask, Phantom, Rabby, Coinbase, …) plus Phantom for Solana. We never touch your keys.
          </p>
          <button
            onClick={connectEvm}
            className="px-5 py-2.5 rounded-xl text-[13px] font-bold text-black transition-all hover:brightness-110"
            style={{ background: 'linear-gradient(135deg, #ffd166 0%, #ff7a3d 100%)' }}
          >
            Connect Wallet
          </button>
        </div>
        <WalletPicker
          open={pickerOpen}
          providers={evmProviders}
          onPick={connectWithProvider}
          onClose={() => setPickerOpen(false)}
        />
      </>
    );
  }

  return (
    <div className="relative">
      {/* Subtle warm ambient glow behind the card */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: '15%',
          bottom: '15%',
          left: '-60px',
          right: '-60px',
          zIndex: 0,
          background: 'radial-gradient(ellipse 80% 70% at 50% 50%, rgba(255,122,61,0.18) 0%, rgba(255,122,61,0.05) 45%, transparent 75%)',
          filter: 'blur(60px)',
        }}
      />

      {/* Portfolio card */}
      <div
        className="relative rounded-[24px] border border-white/[0.08] overflow-hidden backdrop-blur-xl"
        style={{
          background: 'linear-gradient(180deg, rgba(22,22,26,0.55) 0%, rgba(12,12,16,0.70) 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 30px 80px -20px rgba(0,0,0,0.4)',
          zIndex: 1,
        }}
      >
        <div className="relative p-6 space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold tracking-[0.22em] text-white/50">PORTFOLIO</p>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-white/35">
                {walletAddress.slice(0, 4)}…{walletAddress.slice(-4)}
              </span>
              <button
                type="button"
                onClick={disconnect}
                title="Disconnect — then click Connect again to pick MetaMask / a different wallet"
                className="text-[9px] font-bold tracking-[0.15em] uppercase text-white/40 hover:text-white border border-white/[0.08] hover:border-white/[0.16] rounded-md px-2 py-0.5 transition-all"
              >
                Disconnect
              </button>
            </div>
          </div>

          <AllocationDonut
            segments={[
              { value: totalEthUsd,  color: '#627eea', label: 'ETH' },
              { value: totalUsdcUsd, color: '#2775ca', label: 'USDC' },
              { value: solUsd,       color: '#14f195', label: 'SOL' },
              { value: splOtherUsd,  color: '#9945ff', label: 'SPL' },
              { value: polUsd,       color: '#a855f7', label: 'POL' },
              { value: hypeUsd,      color: '#06b6d4', label: 'HYPE' },
            ]}
            centerLabel={fmtUsd(totalUsd)}
            centerSublabel="Total value"
          />

          <div className="space-y-2 pt-2 border-t border-white/[0.05]">
            {userBalances.ethMainnet > 0 && (
              <BreakdownRow
                icon={<TokenIcon symbol="ETH" />}
                label="ETH · Mainnet"
                sub={`${userBalances.ethMainnet.toFixed(5)} ETH`}
                value={fmtUsd(ethMainnetUsd)}
                dotColor="#627eea"
                pct={totalUsd > 0 ? (ethMainnetUsd / totalUsd) * 100 : 0}
              />
            )}
            {userBalances.usdcMainnet > 0 && (
              <BreakdownRow
                icon={<TokenIcon symbol="USDC" />}
                label="USDC · Mainnet"
                sub={`${userBalances.usdcMainnet.toFixed(2)} USDC`}
                value={fmtUsd(usdcMainnetUsd)}
                dotColor="#2775ca"
                pct={totalUsd > 0 ? (usdcMainnetUsd / totalUsd) * 100 : 0}
              />
            )}
            <BreakdownRow
              icon={<TokenIcon symbol="ETH" />}
              label="ETH · Base"
              sub={`${userBalances.eth.toFixed(5)} ETH`}
              value={fmtUsd(ethUsd)}
              dotColor="#627eea"
              pct={totalUsd > 0 ? (ethUsd / totalUsd) * 100 : 0}
            />
            <BreakdownRow
              icon={<TokenIcon symbol="USDC" />}
              label="USDC · Base"
              sub={`${userBalances.usdc.toFixed(2)} USDC`}
              value={fmtUsd(usdcBaseUsd)}
              dotColor="#2775ca"
              pct={totalUsd > 0 ? (usdcBaseUsd / totalUsd) * 100 : 0}
            />
            <BreakdownRow
              icon={<TokenIcon symbol="POL" />}
              label="Polygon"
              sub={`${userBalances.pol.toFixed(4)} POL`}
              value={fmtUsd(polUsd)}
              dotColor="#a855f7"
              pct={totalUsd > 0 ? (polUsd / totalUsd) * 100 : 0}
            />
            {userBalances.polUsdc > 0 && (
              <BreakdownRow
                icon={<TokenIcon symbol="USDC" />}
                label="USDC · Polygon"
                sub={`${userBalances.polUsdc.toFixed(2)} USDC`}
                value={fmtUsd(usdcPolUsd)}
                dotColor="#2775ca"
                pct={totalUsd > 0 ? (usdcPolUsd / totalUsd) * 100 : 0}
              />
            )}
            <BreakdownRow
              icon={<TokenIcon symbol="HYPE" />}
              label="HyperEVM"
              sub={`${userBalances.hype.toFixed(4)} HYPE`}
              value={fmtUsd(hypeUsd)}
              dotColor="#06b6d4"
              pct={totalUsd > 0 ? (hypeUsd / totalUsd) * 100 : 0}
            />
            {userBalances.hlUsdc > 0 && (
              <BreakdownRow
                icon={<TokenIcon symbol="USDC" />}
                label="USDC · Hyperliquid"
                sub={`${userBalances.hlUsdc.toFixed(2)} USDC · perps + spot`}
                value={fmtUsd(usdcHlUsd)}
                dotColor="#2775ca"
                pct={totalUsd > 0 ? (usdcHlUsd / totalUsd) * 100 : 0}
              />
            )}
            {userBalances.sol !== null && (
              <BreakdownRow
                icon={<TokenIcon symbol="SOL" />}
                label="Solana"
                sub={`${userBalances.sol.toFixed(4)} SOL`}
                value={fmtUsd(solUsd)}
                dotColor="#14f195"
                pct={totalUsd > 0 ? (solUsd / totalUsd) * 100 : 0}
              />
            )}
            {userBalances.solAddress && userBalances.solTokens.map((tok) => {
              const usd = tok.usd ?? 0;
              const sym = tok.symbol || `${tok.mint.slice(0, 4)}…${tok.mint.slice(-4)}`;
              const isUsdc = tok.mint === SOL_USDC_MINT;
              const dot = isUsdc ? '#2775ca' : '#9945ff';
              return (
                <BreakdownRow
                  key={tok.mint}
                  icon={<TokenIcon symbol={sym} logoUrl={tok.logo} />}
                  label={isUsdc ? 'USDC · Solana' : `${sym} · Solana`}
                  sub={`${fmtTokenAmount(tok.amount)} ${sym}`}
                  value={fmtUsd(usd)}
                  dotColor={dot}
                  pct={totalUsd > 0 ? (usd / totalUsd) * 100 : 0}
                />
              );
            })}
            {userBalances.sol === null && (
              <>
                <button
                  onClick={connectPhantomSolana}
                  className="w-full flex items-center gap-3 py-2 group hover:bg-white/[0.03] rounded-lg px-1 -mx-1 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-white/[0.03] border border-white/[0.05] flex items-center justify-center text-white/60 flex-shrink-0">
                    <TokenIcon symbol="SOL" />
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-[12px] font-semibold text-white truncate">Solana</p>
                    <p className="text-[10px] text-[#14f195] truncate group-hover:underline">Click to connect Phantom →</p>
                  </div>
                  <span className="text-[12px] font-semibold text-white/35 tabular-nums flex-shrink-0">—</span>
                </button>
                {solConnectError && (
                  <div className="text-[10px] text-red-300/80 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
                    {solConnectError}
                  </div>
                )}
              </>
            )}
          </div>

          <WalletPanel evmAddress={walletAddress} solAddress={userBalances.solAddress} />
        </div>
      </div>
    </div>
  );
}

// ─── Allocation donut ─────────────────────────────────────────
function AllocationDonut({ segments, centerLabel, centerSublabel }: {
  segments: Array<{ value: number; color: string; label: string }>;
  centerLabel: string;
  centerSublabel: string;
}) {
  const R = 88;
  const CIRC = 2 * Math.PI * R;
  const total = segments.reduce((s, x) => s + x.value, 0);
  const GAP = total > 0 ? 4 : 0;

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
        <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="10" />
        {arcs.map((a, i) => (
          <circle
            key={a.label + i}
            cx="110" cy="110" r={R}
            fill="none"
            stroke={a.color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${a.length} ${CIRC - a.length}`}
            strokeDashoffset={-a.start}
            style={{ filter: `drop-shadow(0 0 8px ${a.color}55)`, transition: 'stroke-dasharray 500ms ease' }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="text-[26px] font-black text-white tracking-tight tabular-nums">{centerLabel}</div>
        <div className="text-[10px] uppercase tracking-[0.15em] text-white/40 mt-1">{centerSublabel}</div>
      </div>
    </div>
  );
}

// ─── Breakdown row ────────────────────────────────────────────
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

// ─── Wallet panel (addresses + explorer links) ────────────────
function WalletPanel({ evmAddress, solAddress }: { evmAddress: string; solAddress: string | null }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (val: string, key: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* blocked */ }
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

// ─── Token icon ────────────────────────────────────────────────
function TokenIcon({ symbol, logoUrl }: { symbol: string; logoUrl?: string }) {
  const [imgOk, setImgOk] = useState(true);
  const config: Record<string, { bg: string; glyph: string }> = {
    ETH:  { bg: 'linear-gradient(135deg, #627eea, #3c5bd0)', glyph: 'Ξ' },
    USDC: { bg: 'linear-gradient(135deg, #2775ca, #1b5aa3)', glyph: '$' },
    SOL:  { bg: 'linear-gradient(135deg, #14f195, #9945ff)', glyph: 'S' },
    POL:  { bg: 'linear-gradient(135deg, #a855f7, #6d28d9)', glyph: 'P' },
    HYPE: { bg: 'linear-gradient(135deg, #06b6d4, #0e7490)', glyph: 'H' },
  };
  if (logoUrl && imgOk) {
    return (
      <img
        src={logoUrl}
        alt={symbol}
        className="w-5 h-5 rounded-full object-cover bg-white/[0.04]"
        onError={() => setImgOk(false)}
      />
    );
  }
  const c = config[symbol] || { bg: 'linear-gradient(135deg, #9945ff, #ec4899)', glyph: symbol.slice(0, 1).toUpperCase() };
  return (
    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-black text-white"
      style={{ background: c.bg }}>
      {c.glyph}
    </div>
  );
}
