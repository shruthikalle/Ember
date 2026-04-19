'use client';

interface Totals {
  gas_spend_usd: number;
  compute_spend_usd: number;
  net_profit_usd: number;
  trade_count: number;
  failed_trade_count: number;
}

interface StatsCardsProps {
  agentAddress: string;
  explorerUrl: string;
  balances: { eth: string; usdc: string };
  totals: Totals;
}

function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function shortAddr(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

export default function StatsCards({ agentAddress, explorerUrl, balances, totals }: StatsCardsProps) {
  const profitPositive = totals.net_profit_usd >= 0;
  const successRate = totals.trade_count > 0
    ? Math.round(((totals.trade_count - totals.failed_trade_count) / totals.trade_count) * 100)
    : null;

  return (
    <div className="space-y-5">
      {/* Hero row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Net P&L */}
        <div className="lg:col-span-2 card p-8 relative overflow-hidden">
          <div
            className="absolute -top-32 -right-32 w-80 h-80 rounded-full opacity-20 blur-[80px] float-slow"
            style={{ background: profitPositive
              ? 'radial-gradient(circle, #4ade80, transparent 70%)'
              : 'radial-gradient(circle, #fb7185, transparent 70%)' }}
          />
          <div className="relative flex items-start justify-between">
            <div>
              <div className="label">Net P&amp;L</div>
              <div className="text-[12px] text-[var(--color-text-mute)] mt-1">All time · on Base</div>
            </div>
            <span className={profitPositive ? 'pill pill-up' : 'pill pill-down'}>
              <span className="w-1.5 h-1.5 rounded-full bg-current pulse-dot" />
              {profitPositive ? 'Up' : 'Down'}
            </span>
          </div>

          <div className="relative mt-6 flex items-baseline gap-3">
            <span
              className="serif text-[64px] leading-none tracking-tight"
              style={{ color: profitPositive ? 'var(--color-up)' : 'var(--color-down)' }}
            >
              {formatUsd(totals.net_profit_usd)}
            </span>
            <span className="text-[13px] text-[var(--color-text-mute)]">USD</span>
          </div>

          <div className="relative mt-8 pt-6 border-t border-[var(--color-border)] grid grid-cols-3 gap-4">
            <MiniStat label="Trades" value={String(totals.trade_count)} />
            <MiniStat label="Failed" value={String(totals.failed_trade_count)} tone={totals.failed_trade_count > 0 ? 'down' : undefined} />
            <MiniStat label="Success" value={successRate !== null ? `${successRate}%` : '—'} tone={successRate && successRate >= 90 ? 'up' : undefined} />
          </div>
        </div>

        {/* Agent wallet */}
        <div className="card p-8 flex flex-col">
          <div className="flex items-center justify-between">
            <div className="label">Agent wallet</div>
            <span className="pill">Base</span>
          </div>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 mono text-[14px] text-[var(--color-text)] hover:text-[var(--color-accent)] transition-colors"
          >
            {shortAddr(agentAddress)} <span className="opacity-60">↗</span>
          </a>
          <div className="mt-auto pt-6 space-y-3">
            <BalanceRow symbol="ETH"  amount={parseFloat(balances.eth).toFixed(5)} />
            <BalanceRow symbol="USDC" amount={parseFloat(balances.usdc).toFixed(2)} />
          </div>
        </div>
      </div>

      {/* Metric row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        <MetricCard label="Gas spent" value={formatUsd(totals.gas_spend_usd)}     sub="Onchain fees" />
        <MetricCard label="Compute"   value={formatUsd(totals.compute_spend_usd)} sub="AI inference" />
        <MetricCard label="Volume"    value="—"                                    sub="Coming soon" />
        <MetricCard label="Uptime"    value="99.9%"                                sub="Last 30 days" tone="up" />
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  const color =
    tone === 'up' ? 'var(--color-up)' :
    tone === 'down' ? 'var(--color-down)' :
    'var(--color-text)';
  return (
    <div>
      <div className="label text-[10px]">{label}</div>
      <div className="mt-1 num text-[18px]" style={{ color }}>{value}</div>
    </div>
  );
}

function BalanceRow({ symbol, amount }: { symbol: string; amount: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-full bg-white/[0.04] border border-[var(--color-border)] flex items-center justify-center text-[11px] font-medium text-[var(--color-text-dim)]">
          {symbol === 'ETH' ? 'Ξ' : '$'}
        </span>
        <span className="text-[12px] text-[var(--color-text-dim)]">{symbol}</span>
      </div>
      <span className="num text-[14px] text-[var(--color-text)]">{amount}</span>
    </div>
  );
}

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'up' | 'down' }) {
  const color =
    tone === 'up' ? 'var(--color-up)' :
    tone === 'down' ? 'var(--color-down)' :
    'var(--color-text)';
  return (
    <div className="card card-hover p-6">
      <div className="label">{label}</div>
      <div className="mt-3 serif text-[32px] leading-none tracking-tight" style={{ color }}>{value}</div>
      <div className="mt-2 text-[12px] text-[var(--color-text-mute)]">{sub}</div>
    </div>
  );
}
