'use client';

interface HLTradeParams {
  assetIndex: number;
  coin: string;
  side: 'LONG' | 'SHORT';
  size: string;
  price: string;
  leverage: number;
  szDecimals: number;
  reduceOnly: boolean;
  orderType: 'market' | 'limit';
  tickSize?: number;
}

interface PerpsReviewModalProps {
  tradeParams: HLTradeParams;
  marketData: {
    markPrice: string;
    fundingRate: string;
    maxLeverage: number;
  };
  sizeUsd: number;
  walletAddress: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export default function PerpsReviewModal({
  tradeParams,
  marketData,
  sizeUsd,
  walletAddress,
  onConfirm,
  onCancel,
  loading = false,
}: PerpsReviewModalProps) {
  const notional = parseFloat(tradeParams.size) * parseFloat(tradeParams.price);
  const margin = sizeUsd / tradeParams.leverage;
  const isLong = tradeParams.side === 'LONG';
  const fundingRate = parseFloat(marketData.fundingRate);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal — compact: max 420px wide, capped to 70vh, with scrollable body */}
      <div
        className="relative w-full max-w-[380px] max-h-[70vh] flex flex-col rounded-2xl border border-white/[0.06] overflow-hidden shadow-2xl"
        style={{ background: '#111114' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header (sticky) */}
        <div className="flex-shrink-0 px-5 pt-4 pb-3 border-b border-white/[0.04] flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-white/90">Review Order</h2>
          <button onClick={onCancel} className="text-white/30 hover:text-white/70 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body (scrollable) — min-h-0 is critical for flex children to honor max-h */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-3">
          {/* Direction banner */}
          <div className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${
            isLong
              ? 'bg-emerald-500/[0.06] border-emerald-500/20'
              : 'bg-red-400/[0.06] border-red-400/20'
          }`}>
            <div className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold ${
                isLong ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-400/20 text-red-400'
              }`}>
                {isLong ? '↑' : '↓'}
              </div>
              <div>
                <div className={`text-[13px] font-semibold ${isLong ? 'text-emerald-400' : 'text-red-400'}`}>
                  {tradeParams.side} {tradeParams.coin}
                </div>
                <div className="text-[10px] text-white/30">
                  {tradeParams.orderType === 'market' ? 'Market' : 'Limit'} · {tradeParams.leverage}x
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[13px] font-semibold text-white/90 tabular-nums">${sizeUsd.toFixed(2)}</div>
              <div className="text-[10px] text-white/30 font-mono">{tradeParams.size} {tradeParams.coin}</div>
            </div>
          </div>

          {/* Details */}
          <div className="rounded-lg border border-white/[0.06] overflow-hidden divide-y divide-white/[0.04]">
            <Row label="Entry" value={`$${parseFloat(marketData.markPrice).toLocaleString()}`} />
            <Row label="Size" value={`${tradeParams.size} ${tradeParams.coin}`} sub={`$${notional.toFixed(2)}`} />
            <Row label="Margin" value={`$${margin.toFixed(2)}`} />
            <Row label="Leverage" value={`${tradeParams.leverage}x`} sub={`Max ${marketData.maxLeverage}x`} />
            <Row
              label="Funding"
              value={`${fundingRate >= 0 ? '+' : ''}${(fundingRate * 100).toFixed(4)}%`}
              valueColor={fundingRate >= 0 ? 'text-red-400' : 'text-emerald-400'}
            />
            <Row label="Account" value={`${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`} mono />
          </div>

          {/* Risk */}
          <div className="px-3 py-2 rounded-lg bg-amber-500/[0.04] border border-amber-500/10">
            <div className="text-[10px] text-amber-400/70 leading-snug">
              ⚠️ Leveraged trading can result in losses exceeding your margin.
            </div>
          </div>
        </div>

        {/* Actions (sticky footer) */}
        <div className="flex-shrink-0 px-5 py-3 border-t border-white/[0.04] flex gap-2" style={{ background: '#111114' }}>
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-lg border border-white/[0.06] text-[12px] font-medium text-white/60 hover:text-white/90 hover:bg-white/[0.03] transition-all disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`flex-1 px-4 py-2.5 rounded-lg text-[12px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              isLong
                ? 'bg-emerald-500 hover:bg-emerald-400'
                : 'bg-red-500 hover:bg-red-400'
            }`}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Signing…
              </span>
            ) : (
              `Confirm ${tradeParams.side}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  valueColor = 'text-white/85',
  mono = false,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-[11px] text-white/40">{label}</span>
      <div className="text-right">
        <span className={`text-[12px] font-medium tabular-nums ${valueColor} ${mono ? 'font-mono' : ''}`}>{value}</span>
        {sub && <div className="text-[10px] text-white/25 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}
