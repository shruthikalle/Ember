/**
 * Cross-chain USDC supply-rate reader.
 *
 * Reads USDC supply APYs directly from each protocol — on-chain for EVM
 * (Aave v3 + Compound v3 + Moonwell) and the protocol's own public API for
 * Solana (Kamino + Solend). Returns simple annualized % numbers matching
 * the convention used elsewhere in this codebase (see src/lib/aave.ts,
 * src/lib/compound.ts, src/lib/moonwell.ts).
 *
 * This intentionally skips reward token APY. Adding the reward layer
 * requires per-protocol incentives distributors + a token price feed and is
 * worth a follow-up once base rates are plumbed end-to-end.
 */

import { ethers } from 'ethers';

// ─── Constants ────────────────────────────────────────────────────────────

const USDC_MAINNET  = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_POLYGON  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const AAVE_V3_POOL_MAINNET = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const AAVE_V3_POOL_BASE    = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const AAVE_V3_POOL_POLYGON = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const COMET_USDC_MAINNET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const COMET_USDC_BASE    = '0xb125E6687d4313864e53df431d5425969c15Eb2F';
const COMET_USDC_POLYGON = '0xF25212E676D1F7F89Cd72fFEe66158f541246445';

const MOONWELL_MUSDC_BASE = '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22';

const RAY = 10n ** 27n;
const RATE_SCALE = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

const SOLEND_MAIN_MARKET = '4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY';
const SOL_USDC_MINT      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Public RPCs per chain — env var takes priority so operators can plug in a
// paid provider. First one that clears a simple call wins.
function envList(...names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (v && typeof v === 'string') out.push(v);
  }
  return out;
}

const MAINNET_RPCS = [
  ...envList('MAINNET_RPC_URL', 'NEXT_PUBLIC_MAINNET_RPC_URL'),
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
];

const BASE_RPCS = [
  ...envList('BASE_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL'),
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
];

const POLYGON_RPCS = [
  ...envList('POLYGON_RPC_URL', 'NEXT_PUBLIC_POLYGON_RPC_URL'),
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
];

// ─── Types ────────────────────────────────────────────────────────────────

export type ChainKey = 'mainnet' | 'base' | 'polygon' | 'solana';

export interface ProtocolApy {
  name: string;        // e.g. "aave-v3", "compound-v3", "moonwell", "solend", "kamino"
  apy: number;         // simple annualized %, e.g. 4.5 for 4.5%
  url: string;         // protocol-specific deposit URL
}

export interface ChainApyReport {
  chain: ChainKey;
  chainDisplay: string;
  topApy: number;
  topProtocol: string;
  protocols: ProtocolApy[];
  error?: string;
}

// ─── EVM readers ──────────────────────────────────────────────────────────

async function withProvider<T>(
  rpcs: string[],
  chainId: number,
  run: (provider: ethers.JsonRpcProvider) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
      const chainIdHex = await provider.send('eth_chainId', []);
      if (parseInt(chainIdHex, 16) !== chainId) continue;
      return await run(provider);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('All RPCs failed');
}

const AAVE_POOL_ABI = [
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
];

async function fetchAaveV3Apy(
  rpcs: string[], chainId: number, poolAddr: string, asset: string,
): Promise<number | null> {
  try {
    return await withProvider(rpcs, chainId, async (provider) => {
      const pool = new ethers.Contract(poolAddr, AAVE_POOL_ABI, provider);
      const data = await pool.getReserveData(asset);
      const liquidityRate: bigint = data.currentLiquidityRate ?? data[2];
      if (liquidityRate === undefined || liquidityRate === null) return 0;
      // liquidityRate is in ray (1e27) expressed as APR — simple annualized.
      const bps = (liquidityRate * 10_000n) / RAY;
      return Number(bps) / 100;
    });
  } catch (err) {
    console.warn('[chainApys] aave-v3 fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

const COMET_ABI = [
  'function getUtilization() view returns (uint256)',
  'function getSupplyRate(uint256 utilization) view returns (uint64)',
];

async function fetchCompoundV3Apy(
  rpcs: string[], chainId: number, cometAddr: string,
): Promise<number | null> {
  try {
    return await withProvider(rpcs, chainId, async (provider) => {
      const comet = new ethers.Contract(cometAddr, COMET_ABI, provider);
      const utilization: bigint = await comet.getUtilization();
      const rate: bigint = await comet.getSupplyRate(utilization);
      // rate is per-second × 1e18. Annualize simply to stay consistent with
      // src/lib/compound.ts:getCompoundUsdcSupplyApy.
      const bps = (rate * SECONDS_PER_YEAR * 10_000n) / RATE_SCALE;
      return Number(bps) / 100;
    });
  } catch (err) {
    console.warn('[chainApys] compound-v3 fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

const MTOKEN_ABI = [
  'function supplyRatePerTimestamp() view returns (uint256)',
];

async function fetchMoonwellApy(
  rpcs: string[], chainId: number, mTokenAddr: string,
): Promise<number | null> {
  try {
    return await withProvider(rpcs, chainId, async (provider) => {
      const mToken = new ethers.Contract(mTokenAddr, MTOKEN_ABI, provider);
      const rate: bigint = await mToken.supplyRatePerTimestamp();
      const bps = (rate * SECONDS_PER_YEAR * 10_000n) / RATE_SCALE;
      return Number(bps) / 100;
    });
  } catch (err) {
    console.warn('[chainApys] moonwell fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Solana readers ───────────────────────────────────────────────────────

// Solend returns decimal rates (0.042 = 4.2%) in supplyInterest.
async function fetchSolendUsdcApy(): Promise<number | null> {
  try {
    const url = `https://api.solend.fi/v1/reserves?ids=${SOLEND_MAIN_MARKET}&scope=all`;
    // Fallback: Solend's /reserves endpoint with scope=all returns per-reserve data
    const res = await fetch('https://api.solend.fi/v1/reserves?scope=all', { cache: 'no-store' });
    if (!res.ok) throw new Error(`solend ${res.status}`);
    const data = await res.json();
    const reserves: any[] = Array.isArray(data?.results) ? data.results : [];
    const usdcRes = reserves.find(
      (r) => r?.reserve?.liquidity?.mintPubkey === SOL_USDC_MINT
        && r?.reserve?.lendingMarket === SOLEND_MAIN_MARKET,
    );
    if (!usdcRes) return null;
    const rate = usdcRes?.rates?.supplyInterest;
    const n = typeof rate === 'string' ? parseFloat(rate) : typeof rate === 'number' ? rate : NaN;
    if (!Number.isFinite(n)) return null;
    // API returns % as a decimal (e.g. 4.2) in some responses, or as a 0-1 fraction
    // in others. Normalize: if < 1, treat as fraction and multiply by 100.
    return n < 1 ? n * 100 : n;
  } catch (err) {
    console.warn('[chainApys] solend fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Kamino requires their SDK (state decoded from on-chain program accounts),
// not a simple REST call — adding it is a followup. Solend already gives us
// a representative Solana USDC rate for the rotator MVP.

// ─── Per-chain orchestration ──────────────────────────────────────────────

async function buildEvmChainReport(
  chain: ChainKey,
  display: string,
  rpcs: string[],
  chainId: number,
  aavePool: string,
  comet: string,
  moonwell: string | null,
  asset: string,
): Promise<ChainApyReport> {
  const [aave, compound, mwell] = await Promise.all([
    fetchAaveV3Apy(rpcs, chainId, aavePool, asset),
    fetchCompoundV3Apy(rpcs, chainId, comet),
    moonwell ? fetchMoonwellApy(rpcs, chainId, moonwell) : Promise.resolve(null),
  ]);

  const protocols: ProtocolApy[] = [];
  if (aave !== null)     protocols.push({ name: 'aave-v3',     apy: aave,     url: `https://app.aave.com/reserve-overview/?underlyingAsset=${asset.toLowerCase()}&marketName=proto_${chain}_v3` });
  if (compound !== null) protocols.push({ name: 'compound-v3', apy: compound, url: `https://app.compound.finance/markets/usdc-${chain}` });
  if (mwell !== null)    protocols.push({ name: 'moonwell',    apy: mwell,    url: 'https://moonwell.fi/markets' });

  protocols.sort((a, b) => b.apy - a.apy);
  const top = protocols[0];
  return {
    chain,
    chainDisplay: display,
    topApy: top?.apy ?? 0,
    topProtocol: top?.name ?? '',
    protocols,
    ...(protocols.length === 0 ? { error: 'All protocol reads failed' } : {}),
  };
}

async function buildSolanaReport(): Promise<ChainApyReport> {
  const solend = await fetchSolendUsdcApy();
  const protocols: ProtocolApy[] = [];
  if (solend !== null) protocols.push({ name: 'solend', apy: solend, url: 'https://save.finance/dashboard' });

  protocols.sort((a, b) => b.apy - a.apy);
  const top = protocols[0];
  return {
    chain: 'solana',
    chainDisplay: 'Solana',
    topApy: top?.apy ?? 0,
    topProtocol: top?.name ?? '',
    protocols,
    ...(protocols.length === 0 ? { error: 'All Solana protocol APIs failed' } : {}),
  };
}

export async function fetchAllChainUsdcApys(): Promise<Record<ChainKey, ChainApyReport>> {
  const [mainnet, base, polygon, solana] = await Promise.all([
    buildEvmChainReport('mainnet', 'Ethereum',
      MAINNET_RPCS, 1,
      AAVE_V3_POOL_MAINNET, COMET_USDC_MAINNET, null,
      USDC_MAINNET),
    buildEvmChainReport('base', 'Base',
      BASE_RPCS, 8453,
      AAVE_V3_POOL_BASE, COMET_USDC_BASE, MOONWELL_MUSDC_BASE,
      USDC_BASE),
    buildEvmChainReport('polygon', 'Polygon',
      POLYGON_RPCS, 137,
      AAVE_V3_POOL_POLYGON, COMET_USDC_POLYGON, null,
      USDC_POLYGON),
    buildSolanaReport(),
  ]);
  return { mainnet, base, polygon, solana };
}

// ─── Rotation cost + break-even ───────────────────────────────────────────

/**
 * Static ballpark cost estimates (USD) for a CCTP-based USDC rotation.
 * CCTP itself has no protocol fee; everything here is gas-only.
 * The values are conservative — real cost depends on mainnet gas at time
 * of tx. Re-tune once the execute path is in place and we can read
 * gasPrice live.
 */
const ROTATION_COST_USD: Record<ChainKey, { srcGasUsd: number; dstGasUsd: number }> = {
  mainnet: { srcGasUsd: 8.0, dstGasUsd: 8.0 },
  base:    { srcGasUsd: 0.3, dstGasUsd: 0.3 },
  polygon: { srcGasUsd: 0.1, dstGasUsd: 0.1 },
  solana:  { srcGasUsd: 0.05, dstGasUsd: 0.05 },
};

export function estimateRotationCostUsd(src: ChainKey, dst: ChainKey): number {
  if (src === dst) return 0;
  return ROTATION_COST_USD[src].srcGasUsd + ROTATION_COST_USD[dst].dstGasUsd;
}

/**
 * Break-even period in days for rotating `positionUsd` worth of USDC
 * from src→dst, given the current APY edge. Returns Infinity if there's
 * no edge (can't ever recoup the gas).
 */
export function breakEvenDays(
  positionUsd: number,
  srcApyPct: number,
  dstApyPct: number,
  src: ChainKey,
  dst: ChainKey,
): number {
  const edgePct = dstApyPct - srcApyPct;
  if (!(edgePct > 0) || positionUsd <= 0) return Infinity;
  const cost = estimateRotationCostUsd(src, dst);
  const dailyGainUsd = (edgePct / 100) * positionUsd / 365;
  if (dailyGainUsd <= 0) return Infinity;
  return cost / dailyGainUsd;
}
