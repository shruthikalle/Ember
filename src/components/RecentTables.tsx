'use client';

interface TradeRow {
  trade_id: string;
  command: string;
  trade_tx_hash: string | null;
  status: string;
  gas_cost_usd: number | null;
  compute_cost_usd: number | null;
  builder_code: string | null;
  created_at: string;
}

interface RecentTablesProps {
  trades: TradeRow[];
  explorerBase: string;
}

function shortenHash(h: string | null): string {
  if (!h) return '—';
  if (h.startsWith('auto_')) return 'auto';
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

function timeAgo(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return dateStr;
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">
        <span className="w-1 h-1 rounded-full bg-emerald-400" />
        SUCCESS
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold bg-red-400/10 text-red-400 border border-red-400/20">
        <span className="w-1 h-1 rounded-full bg-red-400" />
        FAILED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold bg-amber-400/10 text-amber-400 border border-amber-400/20">
      <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
      {status.toUpperCase()}
    </span>
  );
}

export default function RecentTables({ trades, explorerBase }: RecentTablesProps) {
  return (
    <div className="space-y-6">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-black bg-gradient-to-r from-white via-purple-200 to-amber-200 bg-clip-text text-transparent tracking-tight">
            Recent Activity
          </h2>
          <p className="text-xs text-white/40 mt-1">Live trade history on Base</p>
        </div>
        <div className="flex items-center gap-2 rounded-full bg-white/5 border border-white/10 px-3 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[11px] font-semibold text-white/70">{trades.length} records</span>
        </div>
      </div>

      {/* Activity card with gradient border */}
      <div className="relative rounded-[24px] p-[1.5px] bg-gradient-to-br from-white/10 via-white/[0.03] to-white/10">
        <div className="relative rounded-[22px] bg-[#0a0a0f]/95 backdrop-blur-xl overflow-hidden">
          {trades.length === 0 ? (
            <div className="text-center py-16 px-6">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-white/10 mb-4">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/60">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 014-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 01-4 4H3" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-white/80">No trades yet</p>
              <p className="text-xs text-white/40 mt-1">Execute a swap above to see activity here</p>
            </div>
          ) : (
            <div>
              {trades.map((t, i) => (
                <div
                  key={t.trade_id}
                  className={`group flex items-center justify-between px-6 py-4 transition-all hover:bg-white/[0.03] ${
                    i !== 0 ? 'border-t border-white/5' : ''
                  }`}
                >
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    {/* Icon */}
                    <div className={`relative w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                      t.status === 'success'
                        ? 'bg-gradient-to-br from-emerald-400/20 to-cyan-400/20 border border-emerald-400/30'
                        : t.status === 'failed'
                        ? 'bg-gradient-to-br from-red-400/20 to-pink-400/20 border border-red-400/30'
                        : 'bg-gradient-to-br from-amber-400/20 to-orange-400/20 border border-amber-400/30'
                    }`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={
                        t.status === 'success'
                          ? 'text-emerald-400'
                          : t.status === 'failed'
                          ? 'text-red-400'
                          : 'text-amber-400'
                      }>
                        <polyline points="17 1 21 5 17 9" />
                        <path d="M3 11V9a4 4 0 014-4h14" />
                        <polyline points="7 23 3 19 7 15" />
                        <path d="M21 13v2a4 4 0 01-4 4H3" />
                      </svg>
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white/90 truncate group-hover:text-white transition-colors" title={t.command}>
                        {t.command}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {t.trade_tx_hash ? (
                          <a
                            href={`${explorerBase}/tx/${t.trade_tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-mono text-purple-300 hover:text-purple-200 transition-colors"
                          >
                            {shortenHash(t.trade_tx_hash)}
                          </a>
                        ) : (
                          <span className="text-[11px] font-mono text-white/30">—</span>
                        )}
                        <span className="text-[11px] text-white/30">·</span>
                        <span className="text-[11px] text-white/40">{timeAgo(t.created_at)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-shrink-0">
                    {t.gas_cost_usd != null && (
                      <div className="text-right hidden sm:block">
                        <p className="text-[9px] font-bold text-white/30 tracking-wider">GAS</p>
                        <p className="text-[11px] font-mono text-white/70 tabular-nums">${t.gas_cost_usd.toFixed(4)}</p>
                      </div>
                    )}
                    <StatusBadge status={t.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
