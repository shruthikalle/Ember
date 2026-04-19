'use client';

/**
 * /earn — Multi-asset yield rotator
 *
 * Asset tabs: USDC (Base) / ETH (mainnet) / SOL (read-only).
 * For USDC, deposits are auto-routed to whichever protocol is currently #1
 * by APY (Aave v3 / Compound v3 / Moonwell). For ETH, we stake to Lido.
 * SOL is informational — deep links out to each protocol's staking UI.
 */

import { useCallback, useEffect, useState } from 'react';
import { getUsdcAdapter, EXECUTABLE_USDC_PROTOCOLS, type ProtocolId } from '@/src/lib/protocols';
import { buildLidoStakeTx, MAINNET_CHAIN_ID } from '@/src/lib/lido';

// ─── Cross-chain rotator types ───────────────────────────────────────────

type ChainKey = 'mainnet' | 'base' | 'polygon' | 'solana';

interface ChainApyReport {
  chain: ChainKey;
  chainDisplay: string;
  topApy: number;
  topProtocol: string;
  protocols: Array<{ name: string; apy: number; url: string }>;
  error?: string;
}

const CHAIN_DISPLAY: Record<ChainKey, string> = {
  mainnet: 'Ethereum',
  base: 'Base',
  polygon: 'Polygon',
  solana: 'Solana',
};

const CHAIN_COLOR: Record<ChainKey, string> = {
  mainnet: '#627eea',
  base: '#0052ff',
  polygon: '#a855f7',
  solana: '#14f195',
};

// Static gas ballpark for a CCTP rotation — mirrors ROTATION_COST_USD on
// the server. Keep in sync with src/lib/earn/chainApys.ts.
const CHAIN_GAS_USD: Record<ChainKey, { src: number; dst: number }> = {
  mainnet: { src: 8.0, dst: 8.0 },
  base:    { src: 0.3, dst: 0.3 },
  polygon: { src: 0.1, dst: 0.1 },
  solana:  { src: 0.05, dst: 0.05 },
};

function rotationCostUsd(src: ChainKey, dst: ChainKey): number {
  if (src === dst) return 0;
  return CHAIN_GAS_USD[src].src + CHAIN_GAS_USD[dst].dst;
}

function breakEvenDays(positionUsd: number, srcApy: number, dstApy: number, src: ChainKey, dst: ChainKey): number {
  const edgePct = dstApy - srcApy;
  if (!(edgePct > 0) || positionUsd <= 0) return Infinity;
  const dailyGainUsd = (edgePct / 100) * positionUsd / 365;
  if (dailyGainUsd <= 0) return Infinity;
  return rotationCostUsd(src, dst) / dailyGainUsd;
}

// ─── Types ───────────────────────────────────────────────────────────────

interface YieldPool {
  pool: string;
  project: string;
  symbol: string;
  apy: number;
  apyBase: number;
  apyReward: number;
  tvlUsd: number;
  chain: string;
  url: string;
}

interface SolPool {
  pool: string;
  project: string;
  displayName: string;
  symbol: string;
  apy: number;
  tvlUsd: number;
  protocolUrl: string;
}

interface UsdcPosition {
  protocol: ProtocolId;
  suppliedUsdc: number;
  apy: number;
  chain: string;
}

interface UsdcBestRate { protocol: ProtocolId; apy: number }

interface EthPosition {
  protocol: string;
  suppliedEth: number;
  apy: number;
  chain: 'ethereum' | 'base';
}

interface EthBestRate { protocol: string; apy: number; chain: string }

type Asset = 'USDC' | 'ETH' | 'SOL';

type Status =
  | { kind: 'idle' }
  | { kind: 'switching_chain' }
  | { kind: 'approving'; hash?: string }
  | { kind: 'supplying'; hash?: string }
  | { kind: 'withdrawing'; hash?: string }
  | { kind: 'done'; message: string; hash?: string }
  | { kind: 'error'; message: string };

const BASE_HEX = '0x2105';
const MAINNET_HEX = '0x1';

// ─── Helpers ─────────────────────────────────────────────────────────────

async function ensureChain(targetHex: string, chainName: string, rpcUrl: string, explorer: string): Promise<void> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error('No EVM wallet detected');
  const cur: string = await eth.request({ method: 'eth_chainId' });
  if (cur?.toLowerCase() === targetHex) return;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: targetHex }] });
  } catch (err: any) {
    if (err?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: targetHex, chainName,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [rpcUrl], blockExplorerUrls: [explorer],
        }],
      });
    } else {
      throw new Error(`Please switch your wallet to ${chainName}.`);
    }
  }
}

async function ensureBase() {
  return ensureChain(BASE_HEX, 'Base', 'https://mainnet.base.org', 'https://basescan.org');
}

async function ensureMainnet() {
  return ensureChain(MAINNET_HEX, 'Ethereum', 'https://eth.llamarpc.com', 'https://etherscan.io');
}

async function waitForTx(hash: string, maxAttempts = 30): Promise<void> {
  const eth = (window as any).ethereum;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (r) return;
    } catch { /* not mined */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function protocolDisplay(id: string): string {
  const map: Record<string, string> = {
    'aave-v3': 'Aave v3',
    'compound-v3': 'Compound v3',
    'moonwell': 'Moonwell',
    'morpho-blue': 'Morpho',
    'fluid-lending': 'Fluid',
    'spark': 'Spark',
  };
  return map[id] ?? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function EarnPage() {
  const [asset, setAsset] = useState<Asset>('USDC');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // USDC state
  const [usdcPools, setUsdcPools] = useState<YieldPool[]>([]);
  const [usdcPositions, setUsdcPositions] = useState<UsdcPosition[]>([]);
  const [usdcBest, setUsdcBest] = useState<UsdcBestRate | null>(null);

  // ETH state
  const [ethPools, setEthPools] = useState<YieldPool[]>([]);
  const [ethPositions, setEthPositions] = useState<EthPosition[]>([]);
  const [ethBest, setEthBest] = useState<EthBestRate | null>(null);

  // SOL state
  const [solPools, setSolPools] = useState<SolPool[]>([]);

  // Cross-chain USDC rotator state
  const [chainApys, setChainApys] = useState<Partial<Record<ChainKey, ChainApyReport>>>({});
  const [chainUsdc, setChainUsdc] = useState<Record<ChainKey, number>>({
    mainnet: 0, base: 0, polygon: 0, solana: 0,
  });

  const [amount, setAmount] = useState<string>('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [poolsError, setPoolsError] = useState<string | null>(null);

  // Detect wallet
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).ethereum) return;
    const eth = (window as any).ethereum;
    eth.request({ method: 'eth_accounts' }).then((a: string[]) => a[0] && setWalletAddress(a[0]));
    const onChange = (a: string[]) => setWalletAddress(a[0] || null);
    eth.on?.('accountsChanged', onChange);
    return () => eth.removeListener?.('accountsChanged', onChange);
  }, []);

  // Fetch yields
  const fetchYields = useCallback(async () => {
    try {
      const [u, e, s] = await Promise.all([
        fetch('/api/yields').then((r) => r.json()).catch(() => ({ pools: [] })),
        fetch('/api/yields-eth').then((r) => r.json()).catch(() => ({ pools: [] })),
        fetch('/api/yields-sol').then((r) => r.json()).catch(() => ({ pools: [] })),
      ]);
      setUsdcPools(Array.isArray(u.pools) ? u.pools : []);
      setEthPools(Array.isArray(e.pools) ? e.pools : []);
      setSolPools(Array.isArray(s.pools) ? s.pools : []);
      setPoolsError(null);
    } catch (err: any) {
      setPoolsError(err?.message || 'Failed to load rates');
    }
  }, []);

  // Fetch positions
  const fetchPositions = useCallback(async () => {
    if (!walletAddress) {
      setUsdcPositions([]); setEthPositions([]); setUsdcBest(null); setEthBest(null);
      return;
    }
    try {
      const [u, e] = await Promise.all([
        fetch(`/api/positions/usdc?address=${walletAddress}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/positions/eth?address=${walletAddress}`).then((r) => r.json()).catch(() => null),
      ]);
      if (u) { setUsdcPositions(u.positions || []); setUsdcBest(u.bestRate || null); }
      if (e) { setEthPositions(e.positions || []); setEthBest(e.bestRate || null); }
    } catch (err) { console.warn('[Earn] positions fetch failed:', err); }
  }, [walletAddress]);

  // Fetch best rates without wallet (so UI shows live rate even when disconnected)
  const fetchBestRates = useCallback(async () => {
    try {
      const [u, e] = await Promise.all([
        fetch('/api/positions/usdc').then((r) => r.json()).catch(() => null),
        fetch('/api/positions/eth').then((r) => r.json()).catch(() => null),
      ]);
      if (u?.bestRate) setUsdcBest(u.bestRate);
      if (e?.bestRate) setEthBest(e.bestRate);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchYields();
    const t = setInterval(fetchYields, 60_000);
    return () => clearInterval(t);
  }, [fetchYields]);

  // Cross-chain USDC: top APYs per chain (fetched regardless of wallet).
  const fetchChainApys = useCallback(async () => {
    try {
      const res = await fetch('/api/earn/usdc-chains');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.chains) setChainApys(data.chains);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchChainApys();
    const t = setInterval(fetchChainApys, 60_000);
    return () => clearInterval(t);
  }, [fetchChainApys]);

  // Cross-chain USDC balances — piggyback on the unified /api/portfolio
  // route. Only EVM USDC for now; Solana USDC requires a separately
  // connected Phantom session, which /earn doesn't track yet.
  useEffect(() => {
    if (!walletAddress) {
      setChainUsdc({ mainnet: 0, base: 0, polygon: 0, solana: 0 });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/portfolio?evm=${walletAddress}&minUsd=0`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const c = data?.chains ?? {};
        const solUsdc = Array.isArray(data?.solana?.tokens)
          ? data.solana.tokens.find((t: any) => t?.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')?.usd ?? 0
          : 0;
        setChainUsdc({
          mainnet: c.mainnet?.usdc ?? 0,
          base:    c.base?.usdc    ?? 0,
          polygon: c.polygon?.usdc ?? 0,
          solana:  solUsdc,
        });
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress]);

  useEffect(() => {
    if (walletAddress) {
      fetchPositions();
      const t = setInterval(fetchPositions, 20_000);
      return () => clearInterval(t);
    } else {
      fetchBestRates();
    }
  }, [walletAddress, fetchPositions, fetchBestRates]);

  const connect = useCallback(async () => {
    if (typeof window === 'undefined' || !(window as any).ethereum) {
      setStatus({ kind: 'error', message: 'No EVM wallet found.' });
      return;
    }
    try {
      const accounts: string[] = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts[0]) setWalletAddress(accounts[0]);
    } catch { /* cancelled */ }
  }, []);

  // Pre-compute the best executable USDC rate — used by both the deposit
  // handler and the UI label. (Declared above the callbacks that depend on it.)
  const executableSet = new Set<string>(EXECUTABLE_USDC_PROTOCOLS);
  const topExecutableUsdc = usdcPools.find((p) => executableSet.has(p.project));
  const usdcFallback: UsdcBestRate | null = topExecutableUsdc
    ? { protocol: topExecutableUsdc.project as ProtocolId, apy: topExecutableUsdc.apy }
    : null;
  const effectiveUsdcBest: UsdcBestRate | null = usdcBest ?? usdcFallback;

  // ─── USDC deposit: route to best-rate protocol ────────────────────────
  const handleUsdcDeposit = useCallback(async () => {
    if (!walletAddress) { setStatus({ kind: 'error', message: 'Connect a wallet first.' }); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setStatus({ kind: 'error', message: 'Enter an amount.' }); return; }

    // Pick best executable protocol. Use the API's bestRate if we have it,
    // otherwise fall back to the highest-APY executable protocol from the
    // public rates feed.
    const best = effectiveUsdcBest;
    if (!best) { setStatus({ kind: 'error', message: 'No executable rate available right now.' }); return; }
    const adapter = getUsdcAdapter(best.protocol);
    if (!adapter) { setStatus({ kind: 'error', message: `No adapter for ${best.protocol}` }); return; }

    const eth = (window as any).ethereum;
    try {
      setStatus({ kind: 'switching_chain' });
      await ensureBase();

      // getAllowance can hit RPC rate limits — if it fails, assume 0 and let
      // the approval tx run. Users can always cancel if a double-approval
      // isn't what they want.
      let allowance = 0;
      try {
        allowance = await adapter.getAllowance(walletAddress);
      } catch (err) {
        console.warn('[Earn] allowance read failed, assuming 0:', err);
      }

      if (allowance < amt) {
        const approvalTx = adapter.buildApprovalTx(amt);
        setStatus({ kind: 'approving' });
        const h1: string = await eth.request({ method: 'eth_sendTransaction', params: [{ from: walletAddress, ...approvalTx }] });
        setStatus({ kind: 'approving', hash: h1 });
        await waitForTx(h1);
      }

      const supplyTx = adapter.buildSupplyTx(walletAddress, amt);
      setStatus({ kind: 'supplying' });
      const h2: string = await eth.request({ method: 'eth_sendTransaction', params: [{ from: walletAddress, ...supplyTx }] });
      setStatus({ kind: 'supplying', hash: h2 });
      await waitForTx(h2);

      // Optimistic update — show the new position immediately.
      setUsdcPositions((prev) => {
        const existing = prev.find((p) => p.protocol === best.protocol);
        if (existing) {
          return prev.map((p) =>
            p.protocol === best.protocol
              ? { ...p, suppliedUsdc: p.suppliedUsdc + amt }
              : p,
          );
        }
        return [...prev, { protocol: best.protocol, suppliedUsdc: amt, apy: best.apy, chain: 'Base' }];
      });

      setStatus({ kind: 'done', message: `Deposited ${amt} USDC to ${adapter.displayName}.`, hash: h2 });
      setAmount('');

      // Re-sync with chain after Base settles (≈ 4 s).
      setTimeout(() => fetchPositions(), 4_000);
    } catch (err: any) {
      setStatus(err?.code === 4001 || err?.code === 'ACTION_REJECTED'
        ? { kind: 'error', message: 'Transaction cancelled.' }
        : { kind: 'error', message: err?.shortMessage || err?.message || 'Deposit failed' });
    }
  }, [walletAddress, amount, effectiveUsdcBest, fetchPositions]);

  const handleUsdcWithdraw = useCallback(async (position: UsdcPosition, all: boolean) => {
    if (!walletAddress) return;
    const amt = all ? undefined : parseFloat(amount);
    if (!all && (!amt || amt <= 0)) { setStatus({ kind: 'error', message: 'Enter an amount.' }); return; }
    const adapter = getUsdcAdapter(position.protocol);
    if (!adapter) return;
    const eth = (window as any).ethereum;
    try {
      setStatus({ kind: 'switching_chain' });
      await ensureBase();
      // buildWithdrawTx may be async (Moonwell withdraw-all reads mToken balance on-chain)
      const tx = await Promise.resolve(adapter.buildWithdrawTx(walletAddress, amt));
      setStatus({ kind: 'withdrawing' });
      const h: string = await eth.request({ method: 'eth_sendTransaction', params: [{ from: walletAddress, ...tx }] });
      setStatus({ kind: 'withdrawing', hash: h });
      await waitForTx(h);

      // Optimistic update — remove / reduce the position immediately so the
      // user sees the change without waiting for the next API round-trip.
      if (all) {
        setUsdcPositions((prev) => prev.filter((p) => p.protocol !== position.protocol));
      } else if (amt) {
        setUsdcPositions((prev) =>
          prev
            .map((p) => p.protocol === position.protocol
              ? { ...p, suppliedUsdc: Math.max(0, p.suppliedUsdc - amt) }
              : p)
            .filter((p) => p.suppliedUsdc > 0),
        );
      }

      setStatus({ kind: 'done', message: all ? 'Withdrew everything.' : `Withdrew ${amt} USDC.`, hash: h });
      setAmount('');

      // Re-sync with chain after a short delay (1-2 Base blocks ≈ 4 s) so
      // the RPC node has time to index the new state.
      setTimeout(() => fetchPositions(), 4_000);
    } catch (err: any) {
      setStatus(err?.code === 4001 || err?.code === 'ACTION_REJECTED'
        ? { kind: 'error', message: 'Transaction cancelled.' }
        : { kind: 'error', message: err?.message || 'Withdraw failed' });
    }
  }, [walletAddress, amount, fetchPositions]);

  // ─── ETH stake (Lido) ─────────────────────────────────────────────────
  const handleEthStake = useCallback(async () => {
    if (!walletAddress) { setStatus({ kind: 'error', message: 'Connect a wallet first.' }); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setStatus({ kind: 'error', message: 'Enter an amount.' }); return; }
    const eth = (window as any).ethereum;
    try {
      setStatus({ kind: 'switching_chain' });
      await ensureMainnet();
      const tx = buildLidoStakeTx(walletAddress, amt);
      setStatus({ kind: 'supplying' });
      const h: string = await eth.request({ method: 'eth_sendTransaction', params: [{ from: walletAddress, ...tx, chainId: `0x${MAINNET_CHAIN_ID.toString(16)}` }] });
      setStatus({ kind: 'supplying', hash: h });
      await waitForTx(h);
      setStatus({ kind: 'done', message: `Staked ${amt} ETH via Lido. stETH credited to your wallet.`, hash: h });
      setAmount('');
      fetchPositions();
    } catch (err: any) {
      setStatus(err?.code === 4001 || err?.code === 'ACTION_REJECTED'
        ? { kind: 'error', message: 'Transaction cancelled.' }
        : { kind: 'error', message: err?.message || 'Stake failed' });
    }
  }, [walletAddress, amount, fetchPositions]);

  // ─── Derived ──────────────────────────────────────────────────────────
  const bestApy =
    asset === 'USDC' ? (effectiveUsdcBest?.apy ?? 0) :
    asset === 'ETH' ? (ethBest?.apy ?? ethPools[0]?.apy ?? 0) :
    (solPools[0]?.apy ?? 0);

  const bestProtocol =
    asset === 'USDC' ? (effectiveUsdcBest ? protocolDisplay(effectiveUsdcBest.protocol) : '—') :
    asset === 'ETH' ? (ethBest?.protocol ?? ethPools[0]?.project) :
    solPools[0]?.displayName;

  const bestChain =
    asset === 'USDC' ? 'Base' :
    asset === 'ETH' ? (ethBest?.chain === 'base' ? 'Base' : 'Ethereum') :
    'Solana';

  const currentPools: Array<{ pool: string; name: string; symbol: string; apy: number; tvl: number; url: string }> =
    asset === 'USDC' ? usdcPools.map((p) => ({ pool: p.pool, name: protocolDisplay(p.project), symbol: p.symbol, apy: p.apy, tvl: p.tvlUsd, url: p.url })) :
    asset === 'ETH' ? ethPools.map((p) => ({ pool: p.pool, name: protocolDisplay(p.project), symbol: p.symbol, apy: p.apy, tvl: p.tvlUsd, url: p.url })) :
    solPools.map((p) => ({ pool: p.pool, name: p.displayName, symbol: p.symbol, apy: p.apy, tvl: p.tvlUsd, url: p.protocolUrl }));

  const totalUsdcValue = usdcPositions.reduce((s, p) => s + p.suppliedUsdc, 0);
  const totalEthValue = ethPositions.reduce((s, p) => s + p.suppliedEth, 0);

  return (
    <div className="relative min-h-screen" style={{ background: '#09090b' }}>
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[1100px] h-[700px] pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, rgba(255,122,61,0.12) 0%, rgba(74,222,128,0.06) 40%, transparent 75%)' }}
      />

      <header className="relative z-20 border-b border-white/[0.06] bg-[#0a0a0c]/70 backdrop-blur-xl">
        <div className="max-w-[1200px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <a href="/" className="flex items-center">
              <span className="text-[18px] font-black tracking-[0.18em] text-white">EMBER</span>
            </a>
            <nav className="hidden md:flex items-center gap-1">
              <a href="/" className="btn-ghost">Home</a>
              <a href="/#try-it" className="btn-ghost">Swap</a>
              <a href="/perps" className="btn-ghost">Perps</a>
              <a href="/predictions" className="btn-ghost">Predictions</a>
              <a href="/memecoins" className="btn-ghost">Memecoins</a>
              <span className="btn-ghost !text-[var(--color-accent)]">Earn</span>
              <a href="/#activity" className="btn-ghost">Activity</a>
            </nav>
          </div>
          {walletAddress ? (
            <span className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px] font-mono text-white/70">
                {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
              </span>
            </span>
          ) : (
            <button onClick={connect}
              className="rounded-full px-4 py-2 text-[12px] font-bold text-black"
              style={{ background: 'linear-gradient(135deg, #ffd166, #ff7a3d)' }}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <main className="relative z-10 max-w-[1100px] mx-auto px-6 py-12 lg:py-16 space-y-10">
        {/* Hero */}
        <section className="text-center max-w-[720px] mx-auto">
          <p className="text-[12px] text-white/40 mb-5">Multi-asset yield, auto-routed</p>
          <h1 className="text-[44px] md:text-[64px] font-black leading-[0.98] tracking-[-0.02em] uppercase">
            <span className="text-white">Earn </span>
            <span className="text-[#ff7a3d]">yield</span>
            <br />
            <span className="text-white">on anything</span>
          </h1>
          <p className="mt-5 text-[14px] text-white/50 max-w-[520px] mx-auto leading-relaxed">
            Stablecoins, ETH, SOL — we check every protocol and route to the highest rate. Non-custodial, withdraw anytime.
          </p>
        </section>

        {/* Asset tabs */}
        <div className="flex justify-center">
          <div className="inline-flex rounded-full border border-white/10 bg-white/[0.02] p-1">
            {(['USDC', 'ETH', 'SOL'] as Asset[]).map((a) => (
              <button
                key={a}
                onClick={() => { setAsset(a); setAmount(''); setStatus({ kind: 'idle' }); }}
                className={`px-5 py-2 text-[12px] font-bold tracking-wider uppercase rounded-full transition-all ${
                  asset === a ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'
                }`}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        {/* Main action card */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
          {/* Big APY + action */}
          <div className="card p-8 relative overflow-hidden">
            <div className="absolute -top-20 -left-20 w-60 h-60 rounded-full opacity-[0.18] blur-[80px]"
              style={{ background: 'radial-gradient(circle, #4ade80, transparent 70%)' }}
            />

            <div className="relative">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <p className="label">Current best rate · {asset}</p>
                  <p className="text-[11px] text-white/40 mt-1">
                    {asset === 'SOL' ? 'Live from DeFi Llama' : 'Live on-chain + DeFi Llama'}
                  </p>
                </div>
                <span className="pill pill-up">
                  <span className="w-1.5 h-1.5 rounded-full bg-current pulse-dot" />
                  Live
                </span>
              </div>

              <div className="flex items-baseline gap-3">
                <span className="serif text-[72px] md:text-[84px] leading-none tracking-tight"
                  style={{ color: 'var(--color-up)' }}>
                  {bestApy.toFixed(2)}%
                </span>
                <span className="text-[14px] font-bold text-white/60 tracking-wider uppercase">APY</span>
              </div>
              <p className="mt-3 text-[13px] text-white/50">
                via <span className="text-white font-semibold">{bestProtocol || '—'}</span>
                {' · '}{bestChain}
              </p>

              {/* User positions */}
              {walletAddress && asset === 'USDC' && usdcPositions.length > 0 && (
                <div className="mt-8 pt-6 border-t border-[var(--color-border)] space-y-3">
                  <p className="label">Your USDC positions</p>
                  {usdcPositions.map((p) => (
                    <div key={p.protocol} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] border border-white/[0.06] px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-white">{protocolDisplay(p.protocol)}</p>
                        <p className="text-[11px] text-white/50 mt-0.5">
                          <span className="num">${p.suppliedUsdc.toFixed(2)}</span>
                          {' · '}
                          <span style={{ color: 'var(--color-up)' }}>{p.apy.toFixed(2)}% APY</span>
                        </p>
                      </div>
                      <button
                        onClick={() => handleUsdcWithdraw(p, true)}
                        disabled={status.kind === 'withdrawing'}
                        className="text-[11px] font-semibold text-white/70 hover:text-white underline whitespace-nowrap"
                      >
                        Withdraw all
                      </button>
                    </div>
                  ))}
                  <p className="text-[11px] text-white/40 pt-1">
                    Total: <span className="num text-white/80">${totalUsdcValue.toFixed(2)}</span>
                    {' · projected /yr: '}
                    <span className="num" style={{ color: 'var(--color-up)' }}>
                      +${usdcPositions.reduce((s, p) => s + p.suppliedUsdc * p.apy / 100, 0).toFixed(2)}
                    </span>
                  </p>
                </div>
              )}

              {walletAddress && asset === 'ETH' && ethPositions.length > 0 && (
                <div className="mt-8 pt-6 border-t border-[var(--color-border)] space-y-3">
                  <p className="label">Your ETH positions</p>
                  {ethPositions.map((p) => (
                    <div key={p.protocol} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] border border-white/[0.06] px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-white">{p.protocol}</p>
                        <p className="text-[11px] text-white/50 mt-0.5">
                          <span className="num">{p.suppliedEth.toFixed(4)} ETH</span>
                          {' · '}
                          <span style={{ color: 'var(--color-up)' }}>{p.apy.toFixed(2)}% APY</span>
                          {' · '}
                          <span className="uppercase text-[9px] tracking-wider">{p.chain}</span>
                        </p>
                      </div>
                    </div>
                  ))}
                  <p className="text-[11px] text-white/40 pt-1">
                    Total: <span className="num text-white/80">{totalEthValue.toFixed(4)} ETH</span>
                  </p>
                </div>
              )}

              {/* Amount input + actions — hidden for SOL */}
              {asset !== 'SOL' ? (
                <div className="mt-8 space-y-3">
                  <label className="block">
                    <span className="label block mb-2">Amount ({asset})</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                      placeholder="0.00"
                      className="input-field text-[18px] font-semibold"
                    />
                  </label>

                  <div className="grid grid-cols-1 gap-2">
                    {walletAddress ? (
                      <button
                        onClick={asset === 'USDC' ? handleUsdcDeposit : handleEthStake}
                        disabled={status.kind === 'switching_chain' || status.kind === 'approving' || status.kind === 'supplying'}
                        className="btn-primary w-full"
                      >
                        {status.kind === 'approving' ? 'Approving…'
                          : status.kind === 'supplying' ? (asset === 'ETH' ? 'Staking…' : 'Depositing…')
                          : (asset === 'ETH' ? `Stake ETH → stETH` : `Deposit to ${bestProtocol ?? 'best rate'}`)}
                      </button>
                    ) : (
                      <button onClick={connect} className="btn-primary w-full">Connect to {asset === 'ETH' ? 'stake' : 'deposit'}</button>
                    )}
                  </div>

                  {asset === 'ETH' && (
                    <p className="text-[11px] text-white/40 leading-relaxed pt-1">
                      Staking via Lido on Ethereum mainnet. You receive stETH that auto-accrues rewards. Unstaking uses Lido's withdrawal queue or a DEX swap.
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-8 pt-6 border-t border-[var(--color-border)]">
                  <p className="label mb-2">SOL staking</p>
                  <p className="text-[12px] text-white/60 leading-relaxed mb-4">
                    Ember's wallet is EVM-only. Click <span className="text-white font-semibold">Stake</span> on any pool below to open that protocol's staking UI in a new tab — you'll need a Solana wallet (Phantom, Solflare) to complete the stake.
                  </p>
                  {solPools[0] && (
                    <a
                      href={solPools[0].protocolUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-primary w-full text-center inline-block"
                    >
                      Stake on {solPools[0].displayName} — {solPools[0].apy.toFixed(2)}%
                    </a>
                  )}
                </div>
              )}

              {/* Status */}
              {status.kind !== 'idle' && (
                <div className={`mt-4 rounded-xl border px-4 py-3 text-[12px] ${
                  status.kind === 'error'
                    ? 'bg-red-500/[0.06] border-red-500/20 text-red-300'
                    : status.kind === 'done'
                    ? 'bg-emerald-500/[0.06] border-emerald-500/20 text-emerald-300'
                    : 'bg-white/[0.03] border-white/10 text-white/70'
                }`}>
                  {status.kind === 'switching_chain' && 'Checking network…'}
                  {status.kind === 'approving' && (status.hash ? `Approving — ${status.hash.slice(0, 10)}…` : 'Confirm approval in your wallet…')}
                  {status.kind === 'supplying' && (status.hash ? `Sending — ${status.hash.slice(0, 10)}…` : 'Confirm in your wallet…')}
                  {status.kind === 'withdrawing' && (status.hash ? `Withdrawing — ${status.hash.slice(0, 10)}…` : 'Confirm withdrawal in your wallet…')}
                  {status.kind === 'done' && (
                    <>
                      ✓ {status.message}
                      {status.hash && (
                        <a href={`${asset === 'ETH' ? 'https://etherscan.io' : 'https://basescan.org'}/tx/${status.hash}`} target="_blank" rel="noopener noreferrer"
                          className="ml-2 underline">View tx</a>
                      )}
                    </>
                  )}
                  {status.kind === 'error' && status.message}
                </div>
              )}
            </div>
          </div>

          {/* How it works */}
          <div className="card p-6 h-fit">
            <p className="label mb-4">How it works</p>
            <ol className="space-y-4">
              {(asset === 'SOL' ? [
                { n: '01', t: 'Pick a protocol', d: 'We surface the top Solana stakers by APY live from DeFi Llama.' },
                { n: '02', t: 'Open in staking UI', d: "Click Stake → you'll go to the protocol's own app with a Solana wallet." },
                { n: '03', t: 'Earn', d: 'Rewards accrue in your LST (jitoSOL, mSOL, etc.) — non-custodial.' },
              ] : asset === 'ETH' ? [
                { n: '01', t: 'Stake ETH → stETH', d: 'One tx on Ethereum mainnet. You get stETH that auto-rebases.' },
                { n: '02', t: 'Auto-compound', d: 'stETH balance grows every day with staking rewards.' },
                { n: '03', t: 'Unstake anytime', d: "Swap stETH → ETH via DEX, or use Lido's withdrawal queue." },
              ] : [
                { n: '01', t: 'Deposit USDC', d: 'You sign a supply tx — funds stay on-chain.' },
                { n: '02', t: 'Auto-routed', d: 'We route to the highest-APY lender on Base (Aave, Compound, Moonwell).' },
                { n: '03', t: 'Withdraw anytime', d: 'Principal + accrued interest back to you.' },
              ]).map((s) => (
                <li key={s.n} className="flex gap-3">
                  <span className="text-[11px] font-mono text-[var(--color-accent)] pt-0.5">{s.n}</span>
                  <div>
                    <p className="text-[13px] font-semibold text-white">{s.t}</p>
                    <p className="text-[11px] text-white/50 mt-0.5">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-5 pt-4 border-t border-[var(--color-border)]">
              <p className="text-[11px] text-white/40 leading-relaxed">
                Your funds never leave your wallet's custody — you sign every deposit and withdrawal.
              </p>
            </div>
          </div>
        </section>

        {/* Cross-chain USDC rotator — shown only on the USDC tab */}
        {asset === 'USDC' && (
          <CrossChainRotator
            chainApys={chainApys}
            chainUsdc={chainUsdc}
            walletConnected={Boolean(walletAddress)}
          />
        )}

        {/* Rates table */}
        <section>
          <div className="flex items-end justify-between mb-4">
            <div>
              <h2 className="text-[22px] font-semibold text-white tracking-tight">All {asset} rates</h2>
              <p className="text-[12px] text-white/40 mt-1">
                {asset === 'USDC' && 'Top stablecoin lending pools on Base, live from DeFi Llama'}
                {asset === 'ETH' && 'Top ETH staking & lending on Ethereum + Base'}
                {asset === 'SOL' && 'Top Solana staking protocols · click to stake on their site'}
              </p>
            </div>
          </div>

          {poolsError ? (
            <div className="card p-6 text-[13px] text-white/50 text-center">
              Unable to load current rates — {poolsError}
            </div>
          ) : currentPools.length === 0 ? (
            <div className="card p-6 text-[13px] text-white/50 text-center">Loading pools…</div>
          ) : (
            <div className="card overflow-hidden">
              <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr] px-5 py-3 border-b border-[var(--color-border)] text-[10px] font-bold tracking-[0.12em] text-white/40 uppercase">
                <span>Protocol</span>
                <span>Asset</span>
                <span className="text-right">APY</span>
                <span className="text-right">TVL</span>
              </div>
              {currentPools.map((p, i) => {
                const isBest = i === 0;
                return (
                  <a
                    key={p.pool}
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`grid grid-cols-[1.5fr_1fr_1fr_1fr] items-center px-5 py-3.5 text-[13px] transition-colors ${
                      isBest ? 'bg-[#ff7a3d]/[0.04]' : ''
                    } hover:bg-white/[0.03] ${i !== currentPools.length - 1 ? 'border-b border-[var(--color-border)]/40' : ''}`}
                  >
                    <span className="flex items-center gap-2 text-white font-medium capitalize">
                      {isBest && (
                        <span className="text-[9px] font-bold tracking-wider text-[#ff7a3d] bg-[#ff7a3d]/[0.12] border border-[#ff7a3d]/30 rounded px-1.5 py-0.5">
                          TOP
                        </span>
                      )}
                      {p.name}
                    </span>
                    <span className="text-white/70">{p.symbol}</span>
                    <span className="text-right num font-semibold" style={{ color: 'var(--color-up)' }}>
                      {p.apy.toFixed(2)}%
                    </span>
                    <span className="text-right text-white/70 num">
                      ${(p.tvl / 1_000_000).toFixed(1)}M
                    </span>
                  </a>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ─── Cross-chain rotator component ──────────────────────────────────────
//
// Reads top USDC APY per chain from /api/earn/usdc-chains (on-chain Aave v3
// + Compound v3 + Moonwell on EVM; Solend on Solana) and the user's USDC
// balance per chain from /api/portfolio. Compares the best chain against
// each other chain where the user holds USDC and computes a CCTP-based
// break-even period. Read-only for now — execute path lands in a follow-up.

function CrossChainRotator({
  chainApys,
  chainUsdc,
  walletConnected,
}: {
  chainApys: Partial<Record<ChainKey, ChainApyReport>>;
  chainUsdc: Record<ChainKey, number>;
  walletConnected: boolean;
}) {
  const chainKeys: ChainKey[] = ['mainnet', 'base', 'polygon', 'solana'];

  const reports = chainKeys
    .map((k) => chainApys[k])
    .filter((r): r is ChainApyReport => Boolean(r));

  // Best chain = highest top-protocol APY across all chains that reported.
  const bestReport = reports.reduce<ChainApyReport | null>(
    (best, r) => (!best || r.topApy > best.topApy ? r : best),
    null,
  );

  // Rotation suggestions: for each chain where the user has USDC AND that
  // chain isn't the best, compute the break-even days.
  const suggestions = bestReport
    ? chainKeys
        .filter((src) => src !== bestReport.chain && chainUsdc[src] > 0)
        .map((src) => {
          const srcReport = chainApys[src];
          if (!srcReport) return null;
          const position = chainUsdc[src];
          // Treat user's "current APY" as the top APY on their current chain
          // — the most generous comparison; if they're on a worse protocol
          // the actual edge is larger than reported.
          const days = breakEvenDays(position, srcReport.topApy, bestReport.topApy, src, bestReport.chain);
          const edge = bestReport.topApy - srcReport.topApy;
          return { src, srcReport, position, days, edge };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null && Number.isFinite(s.days) && s.days > 0)
        .sort((a, b) => a.days - b.days)
    : [];

  return (
    <section>
      <div className="flex items-end justify-between mb-4">
        <div>
          <h2 className="text-[22px] font-semibold text-white tracking-tight">Cross-chain USDC</h2>
          <p className="text-[12px] text-white/40 mt-1">
            Top USDC APY per chain — read straight from Aave v3 + Compound v3 + Moonwell (EVM) and Solend (Solana).
            {!walletConnected && ' Connect a wallet to see rotation suggestions.'}
          </p>
        </div>
        {bestReport && (
          <span className="pill pill-up">
            <span className="w-1.5 h-1.5 rounded-full bg-current pulse-dot" />
            Best: {CHAIN_DISPLAY[bestReport.chain]} · {bestReport.topApy.toFixed(2)}%
          </span>
        )}
      </div>

      {/* Chain grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {chainKeys.map((k) => {
          const r = chainApys[k];
          const balance = chainUsdc[k];
          const isBest = Boolean(bestReport && r && r.chain === bestReport.chain);
          return (
            <div
              key={k}
              className={`card p-5 relative overflow-hidden ${isBest ? 'ring-1 ring-[#ff7a3d]/40' : ''}`}
            >
              <div
                className="absolute -top-10 -right-10 w-28 h-28 rounded-full opacity-[0.18] blur-[50px]"
                style={{ background: `radial-gradient(circle, ${CHAIN_COLOR[k]}, transparent 70%)` }}
              />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-white/60">{CHAIN_DISPLAY[k]}</p>
                  {isBest && (
                    <span className="text-[9px] font-bold tracking-wider text-[#ff7a3d] bg-[#ff7a3d]/[0.12] border border-[#ff7a3d]/30 rounded px-1.5 py-0.5">
                      TOP
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="serif text-[36px] leading-none tracking-tight" style={{ color: 'var(--color-up)' }}>
                    {r ? r.topApy.toFixed(2) : '—'}
                  </span>
                  <span className="text-[11px] font-bold text-white/50">%</span>
                </div>
                <p className="text-[11px] text-white/50 mt-1">
                  via <span className="text-white/80 capitalize">{r?.topProtocol || '—'}</span>
                </p>
                <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
                  <p className="text-[10px] uppercase tracking-wider text-white/40">Your balance</p>
                  <p className="text-[14px] font-semibold text-white num mt-0.5">
                    {walletConnected ? `$${balance.toFixed(2)}` : '—'}
                  </p>
                </div>
                {r && r.protocols.length > 1 && (
                  <p className="text-[10px] text-white/35 mt-2">
                    Also: {r.protocols.slice(1).map((p) => `${p.name} ${p.apy.toFixed(2)}%`).join(' · ')}
                  </p>
                )}
                {r?.error && (
                  <p className="text-[10px] text-red-300/70 mt-2">{r.error}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Rotation suggestions */}
      {walletConnected && suggestions.length > 0 && bestReport && (
        <div className="card p-5 space-y-3">
          <p className="label">Rotation opportunities</p>
          {suggestions.map((s) => {
            const cost = rotationCostUsd(s.src, bestReport.chain);
            const annualGain = (s.edge / 100) * s.position;
            return (
              <div
                key={s.src}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/[0.02] border border-white/[0.06] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-white">
                    <span className="num">${s.position.toFixed(2)}</span> USDC ·{' '}
                    <span className="text-white/60">{CHAIN_DISPLAY[s.src]}</span>
                    <span className="text-white/30 mx-1.5">→</span>
                    <span className="text-white/60">{CHAIN_DISPLAY[bestReport.chain]}</span>
                  </p>
                  <p className="text-[11px] text-white/50 mt-0.5">
                    <span style={{ color: 'var(--color-up)' }}>+{s.edge.toFixed(2)}%</span>
                    {' APY · '}
                    <span className="num">+${annualGain.toFixed(2)}/yr</span>
                    {' · gas ~'}<span className="num">${cost.toFixed(2)}</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-white/40">Break-even</p>
                  <p className="text-[14px] font-semibold num" style={{ color: s.days <= 30 ? 'var(--color-up)' : 'rgba(255,255,255,0.7)' }}>
                    {s.days < 1 ? '<1' : Math.ceil(s.days)} day{s.days >= 1.5 ? 's' : ''}
                  </p>
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-white/35 leading-relaxed">
            Break-even assumes a Circle CCTP hop (no bridge fee) with rough gas ballparks. Rotation execution lands in a follow-up — for now, click a chain card above to go to the protocol.
          </p>
        </div>
      )}
    </section>
  );
}
