'use client';

import type { EIP6963ProviderDetail } from '@/src/lib/evmProvider';

export default function WalletPicker({
  open,
  providers,
  onPick,
  onClose,
}: {
  open: boolean;
  providers: EIP6963ProviderDetail[];
  onPick: (detail: EIP6963ProviderDetail) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/[0.08] p-5"
        style={{
          background: 'linear-gradient(180deg, rgba(22,22,26,0.95) 0%, rgba(12,12,16,0.98) 100%)',
          boxShadow: '0 40px 80px -20px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-bold text-white">Choose a wallet</h3>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md text-white/50 hover:text-white hover:bg-white/[0.06] flex items-center justify-center transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {providers.length === 0 ? (
          <div className="text-[12px] text-white/50 py-4 text-center">
            No EVM wallets detected. Install MetaMask, Phantom, Rabby, or Coinbase Wallet and reload.
          </div>
        ) : (
          <div className="space-y-1.5">
            {providers.map((p) => (
              <button
                key={p.info.uuid}
                onClick={() => onPick(p)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.12] transition-all"
              >
                {p.info.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.info.icon} alt={p.info.name} className="w-8 h-8 rounded-lg" />
                ) : (
                  <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center text-[11px] font-black text-white/60">
                    {p.info.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 text-left min-w-0">
                  <p className="text-[13px] font-semibold text-white truncate">{p.info.name}</p>
                  <p className="text-[10px] text-white/40 truncate font-mono">{p.info.rdns}</p>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/30">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            ))}
          </div>
        )}
        <p className="text-[10px] text-white/35 mt-4 leading-relaxed">
          Pick MetaMask, Phantom, Rabby, or any installed EVM wallet. Phantom is also used separately for Solana.
        </p>
      </div>
    </div>
  );
}
