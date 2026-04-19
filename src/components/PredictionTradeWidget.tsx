'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import MarketPulsePanel from './MarketPulsePanel';
import AnalystPanel from './AnalystPanel';
import type { ContextAnalystResult } from '@/src/lib/predictions/analyst';

// ─── Types ───────────────────────────────────────────────────────────────────

type Stage = 'idle' | 'resolving' | 'disambiguating' | 'preview' | 'executing' | 'done' | 'error';

interface DisambigCandidate {
  slug: string;
  question: string;
  image?: string;
  outcomes: string[];
  outcomePrices: string[];
  volume24hr: number;
  endDate: string;
}

interface DisambigPayload {
  question: string;
  candidates: DisambigCandidate[];
  intent: { action: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO'; amountUsd: number };
}

interface MarketInfo {
  question: string;
  slug: string;
  image: string;
  outcomes: string[];
  outcomePrices: string[];
  negRisk: boolean;
}

interface TradeInfo {
  action: string;
  side: string;
  tokenId: string;
  amountUsd: number;
  price: number;
  estimatedShares: number;
  outcome: string;
}

type AnalysisResult = ContextAnalystResult;

// ─── Props ───────────────────────────────────────────────────────────────────

interface PredictionTradeWidgetProps {
  walletAddress: string | null;
  onConnectWallet: () => Promise<string | null>;
  availableBalance?: number;
  prefill?: {
    marketSlug: string;
    action: 'BUY_YES' | 'BUY_NO';
    marketQuestion: string;
    marketImage?: string;
    outcomePrices: string[];
    outcomes: string[];
    tokenIds?: { yes: string; no: string };
  } | null;
  onClose?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pctFromPrice(p: string): string {
  return `${(parseFloat(p) * 100).toFixed(0)}%`;
}

function ctaLabel(
  stage: Stage,
  prefill: PredictionTradeWidgetProps['prefill'],
): string {
  if (stage === 'preview') {
    if (prefill?.action === 'BUY_NO') return 'Execute Trade (Buy No)';
    if (prefill?.action === 'BUY_YES') return 'Execute Trade (Buy Yes)';
    return 'Confirm & Execute Trade';
  }
  if (stage === 'idle') {
    if (prefill) return 'Preview Trade';
    return 'Analyze Market';
  }
  return 'Confirm & Execute Trade';
}


// ─── Component ───────────────────────────────────────────────────────────────

export default function PredictionTradeWidget({
  walletAddress: _walletAddress,
  onConnectWallet: _onConnectWallet,
  availableBalance,
  prefill,
  onClose,
}: PredictionTradeWidgetProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [command, setCommand] = useState('');
  const [amountUsd, setAmountUsd] = useState('10');
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [resolvedMarket, setResolvedMarket] = useState<MarketInfo | null>(null);
  const [tradeInfo, setTradeInfo] = useState<TradeInfo | null>(null);
  const [executeResult, setExecuteResult] = useState<any>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [summaryStream, setSummaryStream] = useState('');
  const [notTradable, setNotTradable] = useState(false);
  const [pendingReqBody, setPendingReqBody] = useState<any>(null);
  const [disambig, setDisambig] = useState<DisambigPayload | null>(null);

  const amountRef = useRef<HTMLInputElement>(null);
  const isProcessing = stage === 'resolving' || stage === 'executing';

  // Auto-fill 2% of available balance on mount
  useEffect(() => {
    if (availableBalance && availableBalance > 0) {
      const suggested = Math.max(1, Math.floor(availableBalance * 0.02));
      setAmountUsd(String(suggested));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus amount input on mount
  useEffect(() => {
    const t = setTimeout(() => amountRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  // Reset when prefill changes
  useEffect(() => {
    if (prefill) {
      setCommand('');
      setResolvedMarket(null);
      setAnalysis(null);
    }
  }, [prefill]);

  // SSE stream reader for /api/predictions/analyze responses. Falls back to a
  // plain `res.json()` when the endpoint answers with application/json —
  // that's the shape main's route emits (non-streaming) and we want the UI to
  // work against both until the streaming route lands.
  const readAnalysisStream = useCallback(async (
    res: Response,
  ): Promise<{ mode: string; market?: any; volatilityEvent?: any; context?: any; candidates?: any[]; question?: string }> => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      return data;
    }
    return new Promise((resolve, reject) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const lines = part.split('\n');
              let eventType = 'message';
              let dataLine = '';
              for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7).trim();
                if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
              }
              if (!dataLine) continue;
              try {
                const parsed = JSON.parse(dataLine);
                if (eventType === 'chunk') {
                  // Summary text delta — append to the streaming display.
                  // setSummaryStream is a stable setter; safe to call inside callback.
                  setSummaryStream((prev) => prev + (parsed.text ?? ''));
                } else if (eventType === 'status') {
                  setStreamStatus(parsed.message ?? '');
                } else if (eventType === 'result') {
                  resolve(parsed);
                  return;
                } else if (eventType === 'error') {
                  reject(new Error(parsed.error ?? 'Analysis failed'));
                  return;
                }
              } catch { /* malformed chunk — skip */ }
            }
          }
          reject(new Error('Stream ended without result'));
        } catch (err) {
          reject(err);
        }
      };

      pump();
    });
  }, []);

  // Auto-analyze when market is resolved
  useEffect(() => {
    if (!resolvedMarket || analysis || analyzing) return;
    const run = async () => {
      setAnalyzing(true);
      setStreamStatus('');
      setSummaryStream('');
      try {
        const res = await fetch('/api/predictions/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketSlug: resolvedMarket.slug }),
        });
        const data = await readAnalysisStream(res);
        if (data.mode === 'analysis' && data.context) {
          setAnalysis(data.context);
        }
      } catch { /* ignore */ }
      setStreamStatus('');
      setAnalyzing(false);
    };
    run();
  }, [resolvedMarket, analysis, analyzing, readAnalysisStream]);

  // Global Cmd+Enter / Ctrl+Enter to confirm
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (stage === 'preview' && pendingReqBody) handleConfirm();
        else if (stage === 'idle' && !isProcessing) handlePreview();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stage, pendingReqBody, isProcessing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Phase 1: Preview / Analyze ────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    setStage('resolving');
    setError('');
    setTradeInfo(null);
    setExecuteResult(null);
    setResolvedMarket(null);
    setAnalysis(null);
    setSummaryStream('');
    setPendingReqBody(null);
    setDisambig(null);
    setNotTradable(false);

    try {
      if (!prefill && command.trim()) {
        setStatusMsg('Finding market & forming a view...');
        setStreamStatus('');

        const res = await fetch('/api/predictions/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: command.trim() }),
        });

        const data = await readAnalysisStream(res);
        setStreamStatus('');

        if (data.mode === 'disambiguate' && Array.isArray(data.candidates)) {
          setDisambig({
            question: data.question || 'Which market did you mean?',
            candidates: data.candidates,
            intent: { action: 'BUY_YES', amountUsd: parseFloat(amountUsd) || 10 },
          });
          setStage('disambiguating');
          return;
        }

        if (data.market) setResolvedMarket(data.market);
        if (data.mode === 'analysis' && data.context) {
          setAnalysis(data.context);
        }
        setStage('idle');
        return;
      }

      if (prefill) {
        // Derive current price from prefill data the widget already has —
        // avoids a slow Gamma re-fetch on the server just to get the price.
        const isYes = prefill.action === 'BUY_YES';
        const priceIdx = isYes ? 0 : 1;
        const knownPrice = parseFloat(prefill.outcomePrices[priceIdx] ?? 'NaN');

        const reqBody: any = {
          marketSlug: prefill.marketSlug,
          action: prefill.action,
          amountUsd: parseFloat(amountUsd) || 10,
          confirm: false,
        };
        if (prefill.tokenIds) reqBody.tokenIds = prefill.tokenIds;
        if (Number.isFinite(knownPrice) && knownPrice > 0 && knownPrice < 1) {
          reqBody.currentPrice = knownPrice;
        }

        setStatusMsg('Checking price...');

        const res = await fetch('/api/predictions/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        });

        const data = await res.json().catch(() => ({}));
        if (data.market) setResolvedMarket(data.market);

        if (!res.ok) {
          const msg = data.error || `HTTP ${res.status}`;
          if (/no liquidity/i.test(msg) && data.market) {
            setNotTradable(true);
            setStage('idle');
            return;
          }
          throw new Error(msg);
        }

        setTradeInfo(data.trade);
        setPendingReqBody(reqBody);
        setStage('preview');
        return;
      }

      throw new Error('Type a topic to analyze, or click a market');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [prefill, command, amountUsd]);

  // ── Disambiguation ────────────────────────────────────────────────────────
  const pickCandidate = useCallback(async (slug: string) => {
    setStage('resolving');
    setError('');
    setDisambig(null);
    setStatusMsg('Analyzing selected market...');

    try {
      setStreamStatus('');
      setSummaryStream('');
      const res = await fetch('/api/predictions/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketSlug: slug }),
      });
      const data = await readAnalysisStream(res);
      setStreamStatus('');
      if (data.market) setResolvedMarket(data.market);
      if (data.mode === 'analysis' && data.context) {
        setAnalysis(data.context);
      }
      setStage('idle');
    } catch (err) {
      setStreamStatus('');
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [readAnalysisStream]);

  // ── (No agent pick — Context Engine does not recommend trades) ───────────
  const useAgentPick = useCallback(async () => {
    /* no-op after pivot to Context Engine */
  }, []);

  // ── Phase 2: Confirm & Execute ────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    if (!pendingReqBody) return;
    setStage('executing');
    setError('');
    setStatusMsg('Executing trade on Polymarket...');

    try {
      const res = await fetch('/api/predictions/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pendingReqBody, confirm: true }),
      });

      const data = await res.json().catch(() => ({}));
      if (data.market) setResolvedMarket(data.market);
      if (data.trade) setTradeInfo(data.trade);
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setExecuteResult(data.result);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, [pendingReqBody]);

  function reset() {
    setStage('idle');
    setError('');
    setStatusMsg('');
    setTradeInfo(null);
    setResolvedMarket(null);
    setExecuteResult(null);
    setPendingReqBody(null);
    setAnalysis(null);
    setSummaryStream('');
    setAnalyzing(false);
    setDisambig(null);
    setNotTradable(false);
  }

  // Derived — no side recommendation in Context Engine mode
  const recommendedOutcome: 'Yes' | 'No' | null = null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="panel glow-accent relative flex flex-col"
      style={{ fontFamily: "'Inter', 'Geist', sans-serif" }}
    >
      {onClose && (
        <button
          className="absolute top-3 right-3 text-trading-text-dim hover:text-trading-text transition-colors z-10"
          onClick={onClose}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 mb-4 flex-shrink-0">
        <div className="w-7 h-7 rounded-lg bg-trading-accent-dim flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-trading-accent">
            <path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" />
          </svg>
        </div>
        <div className="leading-tight">
          <h3 className="text-sm font-bold tracking-tight text-trading-text">Trade Prediction</h3>
          <p className="text-[10px] text-trading-text-dim">Polymarket CLOB</p>
        </div>
      </div>

      {/* ─── Scrollable research region ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-3 pr-0.5 mb-3">

        {/* NL Input */}
        {!prefill && stage !== 'done' && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-2"
          >
            <input
              className="w-full bg-[#0d0d0d] border border-white/[0.07] rounded-xl px-4 py-2.5 text-sm
                text-white placeholder:text-white/25 focus:outline-none
                focus:border-[#ff7a3d] focus:shadow-[0_0_0_3px_rgba(255,122,61,0.12)]
                transition-all duration-200 tracking-tight"
              placeholder='e.g. "Trump 2028 election" — agent forms a view'
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={isProcessing}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isProcessing) handlePreview(); }}
            />
            <div className="flex flex-wrap gap-1.5">
              {['Trump 2028 election', 'Bitcoin price 2025', 'Fed rate cut 2025'].map((preset) => (
                <motion.button
                  key={preset}
                  whileTap={{ scale: 0.96 }}
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06]
                    text-white/40 hover:text-white/70 hover:border-white/[0.12] transition-all tracking-tight"
                  onClick={() => setCommand(preset)}
                  disabled={isProcessing}
                >
                  {preset}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Prefill market card */}
        {prefill && stage !== 'done' && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#0d0d0d] rounded-xl p-3 border border-white/[0.07]"
          >
            <p className="text-sm font-semibold tracking-tight text-white leading-tight mb-2">
              {prefill.marketQuestion}
            </p>
            <div className="flex items-center gap-2">
              {prefill.outcomes.map((outcome, i) => (
                <span
                  key={outcome}
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-md tracking-tight ${
                    i === 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                  }`}
                >
                  {outcome} {prefill.outcomePrices[i] ? `${(parseFloat(prefill.outcomePrices[i]) * 100).toFixed(0)}%` : ''}
                </span>
              ))}
              <span className={`ml-auto text-[11px] font-bold px-2 py-0.5 rounded-md tracking-tight ${
                prefill.action === 'BUY_YES' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
              }`}>
                {prefill.action === 'BUY_YES' ? 'Buy Yes' : 'Buy No'}
              </span>
            </div>
          </motion.div>
        )}

        {/* Resolving spinner */}
        <AnimatePresence>
          {stage === 'resolving' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-3 py-3 text-white/50"
            >
              <div className="w-4 h-4 border-2 border-[#ff7a3d]/30 border-t-[#ff7a3d] rounded-full animate-spin flex-shrink-0" />
              <span className="text-xs tracking-tight">{statusMsg || 'Finding market & forming a view...'}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Executing banner */}
        <AnimatePresence>
          {stage === 'executing' && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-xl p-4 border border-[#3b82f6]/20 bg-[#3b82f6]/[0.05]"
            >
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 border-2 border-[#3b82f6]/30 border-t-[#3b82f6] rounded-full animate-spin flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold tracking-tight text-white">Executing Trade</p>
                  <p className="text-xs text-white/40 mt-0.5 tracking-tight">{statusMsg}</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Disambiguation */}
        {stage === 'disambiguating' && disambig && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-2"
          >
            <div className="rounded-xl border border-[#ff7a3d]/20 bg-[#ff7a3d]/[0.04] p-3">
              <p className="text-[10px] font-bold tracking-[0.16em] uppercase text-[#ff7a3d]/80 mb-1">Which one?</p>
              <p className="text-[13px] text-white/70 leading-snug tracking-tight">{disambig.question}</p>
            </div>
            <div className="space-y-1.5">
              {disambig.candidates.map((c) => {
                const yesPrice = c.outcomePrices[0] ? parseFloat(c.outcomePrices[0]) : null;
                const yesPct = yesPrice !== null ? `${(yesPrice * 100).toFixed(0)}¢` : '—';
                const isYesSide = disambig.intent.action === 'BUY_YES' || disambig.intent.action === 'SELL_YES';
                const displayPct = isYesSide ? yesPct : yesPrice !== null ? `${((1 - yesPrice) * 100).toFixed(0)}¢` : '—';
                const vol = c.volume24hr >= 1_000_000
                  ? `$${(c.volume24hr / 1_000_000).toFixed(1)}M`
                  : c.volume24hr >= 1_000
                    ? `$${(c.volume24hr / 1_000).toFixed(0)}K`
                    : `$${Math.round(c.volume24hr)}`;
                const end = c.endDate ? new Date(c.endDate) : null;
                const endLabel = end && !isNaN(end.getTime())
                  ? end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                  : null;

                return (
                  <motion.button
                    key={c.slug}
                    whileHover={{ borderColor: 'rgba(255,122,61,0.35)' }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => pickCandidate(c.slug)}
                    className="w-full text-left rounded-xl border border-white/[0.06] bg-white/[0.015]
                      hover:bg-[#ff7a3d]/[0.03] p-3 transition-all"
                  >
                    <div className="flex items-start gap-3">
                      {c.image && (
                        <div className="flex-shrink-0 w-9 h-9 rounded-lg overflow-hidden bg-black/40 border border-white/[0.05]">
                          <img src={c.image} alt="" className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold tracking-tight text-white leading-tight">{c.question}</p>
                        <div className="flex items-center gap-2.5 mt-1.5 text-[10px] text-white/35">
                          <span>
                            <span className={`font-semibold ${isYesSide ? 'text-emerald-400' : 'text-red-400'}`}>
                              {isYesSide ? 'YES' : 'NO'}
                            </span>{' '}@ {displayPct}
                          </span>
                          <span>·</span>
                          <span>{vol} vol</span>
                          {endLabel && <><span>·</span><span>Ends {endLabel}</span></>}
                        </div>
                      </div>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        className="text-white/20 flex-shrink-0 mt-1">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                  </motion.button>
                );
              })}
            </div>
            <button onClick={reset} className="w-full text-[11px] text-white/30 hover:text-white/60 py-2 transition-colors tracking-tight">
              Cancel — type a different command
            </button>
          </motion.div>
        )}

        {/* Matched market card */}
        <AnimatePresence>
          {resolvedMarket && !prefill && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-[#0d0d0d] rounded-xl p-4 border border-white/[0.07]"
            >
              <div className="flex items-start gap-3">
                {resolvedMarket.image && (
                  <div className="flex-shrink-0 w-11 h-11 rounded-lg overflow-hidden bg-black/40">
                    <img src={resolvedMarket.image} alt="" className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70 mb-1">Matched Market</p>
                  <p className="text-sm font-semibold tracking-tight text-white leading-tight">{resolvedMarket.question}</p>
                </div>
              </div>
              {resolvedMarket.outcomes.length > 0 && (
                <div className="flex items-center gap-3 mt-3">
                  {resolvedMarket.outcomes.map((outcome, i) => {
                    const price = resolvedMarket.outcomePrices[i];
                    const pct = price ? parseFloat(price) * 100 : 0;
                    return (
                      <div key={outcome} className="flex-1">
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className={`font-semibold tracking-tight ${i === 0 ? 'text-emerald-400' : 'text-red-400'}`}>{outcome}</span>
                          <span className={`font-bold ${i === 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pctFromPrice(price || '0')}</span>
                        </div>
                        <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className={`h-full rounded-full ${i === 0 ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Trade preview details */}
        <AnimatePresence>
          {tradeInfo && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`rounded-xl p-4 border ${
                stage === 'done'
                  ? 'bg-emerald-500/[0.06] border-emerald-500/20'
                  : 'bg-[#0d0d0d] border-white/[0.07]'
              }`}
            >
              {stage === 'done' && (
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-emerald-400">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <p className="text-sm font-semibold tracking-tight text-emerald-400">Trade Executed</p>
                </div>
              )}
              {stage === 'preview' && (
                <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70 mb-2">Trade Preview</p>
              )}
              <div className="space-y-1.5 text-sm">
                {[
                  { label: 'Position', value: `${tradeInfo.side} ${tradeInfo.outcome}`, color: tradeInfo.outcome === 'Yes' ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Amount', value: `$${tradeInfo.amountUsd}`, color: 'text-white' },
                  { label: 'Price', value: `${(tradeInfo.price * 100).toFixed(1)}%`, color: 'text-white/60' },
                  { label: 'Est. Shares', value: `~${tradeInfo.estimatedShares.toFixed(2)}`, color: 'text-white/60' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-white/35 tracking-tight">{label}</span>
                    <span className={`font-semibold tracking-tight ${color}`}>{value}</span>
                  </div>
                ))}
                {executeResult?.orderID && (
                  <div className="flex justify-between">
                    <span className="text-white/35 tracking-tight">Order ID</span>
                    <span className="font-mono text-xs text-white/40">{executeResult.orderID.slice(0, 16)}…</span>
                  </div>
                )}
                {executeResult?.status && (
                  <div className="flex justify-between">
                    <span className="text-white/35 tracking-tight">Status</span>
                    <span className="text-emerald-400 font-semibold tracking-tight">{executeResult.status}</span>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error */}
        <AnimatePresence>
          {stage === 'error' && error && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl p-4 border border-red-500/20 bg-red-500/[0.05]"
            >
              <div className="flex items-start gap-2">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  className="text-red-400 flex-shrink-0 mt-0.5">
                  <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <p className="text-sm text-red-400 tracking-tight">{error}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Analyst */}
        {(analyzing || analysis) && (
          <AnalystPanel
            analyzing={analyzing}
            context={analysis ?? null}
            streamedSummary={summaryStream || undefined}
            streamStatus={streamStatus}
          />
        )}

        {/* Market Pulse + Whale Feed — hidden until analysis completes */}
        {resolvedMarket && (
          <MarketPulsePanel
            slug={resolvedMarket.slug}
            recommendedSide={recommendedOutcome}
            analysisReady={!analyzing && analysis !== null}
          />
        )}
      </div>

      {/* ─── STICKY EXECUTION DOCK ──────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-white/[0.06] pt-3 space-y-2.5">

        {/* Amount input + chips */}
        {stage !== 'done' && stage !== 'executing' && stage !== 'disambiguating' && (
          <div className="space-y-2">
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25 text-sm font-medium pointer-events-none">$</span>
              <input
                ref={amountRef}
                type="number"
                min="1"
                step="1"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
                disabled={isProcessing}
                className="w-full bg-[#0A0A0A] border border-white/[0.08] rounded-xl pl-7 pr-14 py-3 text-sm font-semibold
                  text-white placeholder:text-white/20 focus:outline-none
                  focus:border-[#ff7a3d] focus:shadow-[0_0_0_3px_rgba(255,122,61,0.12)]
                  transition-all duration-200 tracking-tight disabled:opacity-50"
                placeholder="10"
              />
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/20 text-xs font-medium pointer-events-none tracking-tight">USD</span>
            </div>

            <div className="flex gap-2">
              {[
                { label: '$10', value: '10' },
                { label: '$50', value: '50' },
                { label: 'Max', value: availableBalance ? String(Math.floor(availableBalance)) : null },
              ].map(({ label, value }) => {
                if (!value) return null;
                return (
                  <motion.button
                    key={label}
                    whileTap={{ scale: 0.94 }}
                    onClick={() => setAmountUsd(value)}
                    disabled={isProcessing}
                    className={`flex-1 text-[11px] font-semibold py-1.5 rounded-lg border tracking-tight transition-all ${
                      amountUsd === value
                        ? 'bg-[#ff7a3d]/15 border-[#ff7a3d]/40 text-[#ff7a3d]'
                        : 'bg-white/[0.03] border-white/[0.07] text-white/40 hover:text-white/70 hover:border-white/[0.12]'
                    } disabled:opacity-40`}
                  >
                    {label}
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}

        {/* Primary CTA */}
        {stage === 'idle' && !notTradable && (
          <motion.button
            whileHover={{ opacity: 0.92 }}
            whileTap={{ scale: 0.98 }}
            onClick={handlePreview}
            disabled={!prefill && !command.trim() && !resolvedMarket}
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl
              bg-[#ff7a3d] text-black text-[13px] font-bold tracking-tight
              disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <span>{ctaLabel(stage, prefill)}</span>
            <span className="text-xs font-semibold opacity-60 font-mono">⌘↵</span>
          </motion.button>
        )}

        {stage === 'idle' && notTradable && (
          <div className="w-full text-[11px] text-white/30 text-center py-3 rounded-xl bg-white/[0.03] border border-white/[0.05] tracking-tight">
            Thin orderbook — not tradable right now
          </div>
        )}

        {stage === 'preview' && tradeInfo && (
          <motion.button
            whileHover={{ opacity: 0.92 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleConfirm}
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl
              text-[13px] font-bold tracking-tight transition-all
              bg-[#ff7a3d] text-black"
          >
            <span>Confirm &amp; Execute Trade</span>
            <span className="text-xs font-semibold opacity-60 font-mono">⌘↵</span>
          </motion.button>
        )}

        {stage === 'error' && (
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={reset}
            className="w-full flex items-center justify-center px-4 py-3 rounded-xl
              bg-white/[0.06] border border-white/[0.08] text-white/70 text-[13px] font-semibold tracking-tight transition-all"
          >
            Try Again
          </motion.button>
        )}

        {stage === 'done' && (
          <div className="flex gap-2">
            <a
              href="https://polymarket.com/portfolio"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-center text-[13px] font-semibold py-3 rounded-xl
                bg-white/[0.05] border border-white/[0.08] text-white/60 tracking-tight
                hover:bg-white/[0.08] transition-all"
            >
              View Portfolio
            </a>
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => { reset(); onClose?.(); }}
              className="flex-1 text-[13px] font-bold py-3 rounded-xl bg-[#ff7a3d] text-black tracking-tight"
            >
              Done
            </motion.button>
          </div>
        )}
      </div>
    </div>
  );
}
