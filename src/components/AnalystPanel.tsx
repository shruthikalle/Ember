'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Transition, TargetAndTransition } from 'framer-motion';
import type { ContextAnalystResult } from '@/src/lib/predictions/analyst';

// ─── Types ───────────────────────────────────────────────────────────────────

export type { ContextAnalystResult };

interface Props {
  /** True while the fetch + stream is in flight. */
  analyzing: boolean;
  /** Set once the full structured result (sentiment, sources) arrives. */
  context: ContextAnalystResult | null;
  /**
   * Accumulating plain-text summary chunks from the stream. The parent
   * appends each `event: chunk` payload here; the component renders whatever
   * is present. Undefined means no chunks have arrived yet (web search phase).
   */
  streamedSummary?: string;
  /** Status label forwarded from SSE `event: status` — shown in the loader. */
  streamStatus?: string;
}

// ─── Visual states ────────────────────────────────────────────────────────────
//
//  1. isWaitingSearch — analyzing=true, no chunks, no context yet
//     → full loading overlay (waveform + skeleton)
//  2. isStreaming     — analyzing=true, chunks arriving, no final context yet
//     → panel visible with growing typewriter text + blinking cursor
//  3. hasContext      — final result received
//     → clean resolved UI (sentiment badge + sources)

// ─── Constants ───────────────────────────────────────────────────────────────

const LOADING_STATUSES = [
  'Searching live news feeds...',
  'Cross-referencing breaking events...',
  'Scanning financial publications...',
  'Reviewing recent headlines...',
  'Assessing market sentiment...',
  'Structuring intelligence report...',
];

const WAVEFORM_BARS = 14;
const ACCENT = '#ff7a3d';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fadeUp(delay: number): {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  transition: Transition;
} {
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.38, ease: 'easeOut' as const, delay },
  };
}

function sentimentColor(sentiment: 'Positive' | 'Negative' | 'Mixed'): string {
  if (sentiment === 'Positive') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20';
  if (sentiment === 'Negative') return 'bg-red-500/15 text-red-400 border-red-500/20';
  return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20';
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function sourceLabel(src: string): string {
  if (!isUrl(src)) return src;
  try {
    const u = new URL(src);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return src.slice(0, 60);
  }
}

// ─── Ghost primitives ─────────────────────────────────────────────────────────

function GhostBox({ className = '', children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={`rounded-lg bg-white/[0.025] border border-white/[0.04] ${className}`}>
      {children}
    </div>
  );
}

function GhostLine({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`rounded bg-white/[0.03] ${className}`} style={style} />;
}

// ─── Skeleton silhouette ──────────────────────────────────────────────────────

function AnalystSkeleton() {
  return (
    <div className="space-y-3 pointer-events-none select-none" aria-hidden>
      <GhostBox className="p-3 space-y-2">
        <GhostLine className="h-2 w-20" />
        <GhostLine className="h-5 w-32" />
      </GhostBox>
      <div className="space-y-1.5">
        <GhostLine className="h-2 w-full" />
        <GhostLine className="h-2 w-5/6" />
        <GhostLine className="h-2 w-4/6" />
      </div>
      <div className="flex gap-2 pt-1">
        <GhostLine className="h-5 w-16 rounded-full" />
      </div>
      <div className="space-y-1 pt-2 border-t border-white/[0.04]">
        <GhostLine className="h-2 w-12" />
        {[0.7, 0.5].map((w, i) => (
          <GhostLine key={i} className="h-2" style={{ maxWidth: `${w * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

// ─── Waveform ─────────────────────────────────────────────────────────────────

function Waveform() {
  return (
    <div className="flex items-center gap-[3px] h-5" aria-hidden>
      {Array.from({ length: WAVEFORM_BARS }).map((_, i) => (
        <motion.div
          key={i}
          className="w-[3px] rounded-full"
          style={{ backgroundColor: ACCENT, originY: 0.5 }}
          animate={{ height: ['3px', `${8 + Math.sin(i * 0.7) * 5 + 5}px`, '3px'] }}
          transition={{
            duration: 1.1 + (i % 3) * 0.15,
            repeat: Infinity,
            delay: i * 0.07,
            ease: 'easeInOut' as const,
          }}
        />
      ))}
    </div>
  );
}

// ─── Status cycler ────────────────────────────────────────────────────────────

function StatusCycler({ active, override }: { active: boolean; override?: string }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!active || override) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % LOADING_STATUSES.length), 2500);
    return () => clearInterval(t);
  }, [active, override]);

  const displayText = override || LOADING_STATUSES[idx];
  const key = override ? `override-${override}` : idx;

  return (
    <div className="relative h-4 overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.p
          key={key}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35, ease: 'easeOut' as const }}
          className="absolute inset-0 text-[11px] text-white/45 tracking-tight whitespace-nowrap overflow-hidden text-ellipsis"
        >
          {displayText}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

// ─── Elapsed timer ────────────────────────────────────────────────────────────

function ElapsedTimer({ active }: { active: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [active]);

  return (
    <span className="animate-pulse font-mono text-[11px] text-white/90 font-medium tracking-tight tabular-nums">
      {elapsed}s elapsed
    </span>
  );
}

// ─── Progress shimmer ─────────────────────────────────────────────────────────

function ProgressBar() {
  return (
    <div className="relative h-px w-full rounded-full overflow-hidden bg-white/[0.05]">
      <motion.div
        className="absolute inset-y-0 w-[40%] rounded-full"
        style={{ background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)` }}
        animate={{ x: ['-100%', '350%'] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' as const }}
      />
    </div>
  );
}

// ─── Blinking cursor ──────────────────────────────────────────────────────────

function Cursor() {
  return (
    <motion.span
      className="inline-block w-px h-[0.85em] bg-white/45 ml-[2px] align-middle"
      aria-hidden
      animate={{ opacity: [1, 0] }}
      transition={{ duration: 0.55, repeat: Infinity, repeatType: 'reverse', ease: 'linear' as const }}
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnalystPanel({ analyzing, context, streamedSummary, streamStatus }: Props) {
  const isWaitingSearch = analyzing && !context && !streamedSummary;
  const isStreaming     = analyzing && !context && !!streamedSummary;
  const hasContext      = !!context;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative rounded-xl border border-white/[0.07] overflow-hidden"
      style={{ background: '#0d0d0d' }}
    >
      {/* ── LOADING OVERLAY (web-search phase only — before first chunk) ─────── */}
      <AnimatePresence>
        {isWaitingSearch && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 z-10 flex flex-col p-4"
            style={{ background: 'rgba(13,13,13,0.92)', backdropFilter: 'blur(2px)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70">
                Context Engine
              </p>
              <ElapsedTimer active={isWaitingSearch} />
            </div>

            <div className="flex flex-col gap-3 mb-5">
              <Waveform />
              <StatusCycler active={isWaitingSearch} override={streamStatus} />
              <ProgressBar />
            </div>

            <AnalystSkeleton />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── RESOLVED / STREAMING CONTENT ─────────────────────────────────────── */}
      <div className={`p-4 space-y-3 ${isWaitingSearch ? 'invisible' : ''}`}>

        {/* Header row */}
        <motion.div {...fadeUp(0)} className="flex items-center justify-between">
          <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#ff7a3d]/70">
            Context Engine
          </p>
          {hasContext && !context.degraded && (
            <motion.span
              {...fadeUp(0.05)}
              className={`text-[10px] font-bold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full border ${
                sentimentColor(context.sentiment)
              }`}
            >
              {context.sentiment}
            </motion.span>
          )}
        </motion.div>

        {/* ── STREAMING: typewriter summary ─────────────────────────────────── */}
        {isStreaming && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-white/25 mb-1.5">
              Latest News
            </p>
            <p className="text-[13px] text-white/70 leading-relaxed tracking-tight font-light">
              {streamedSummary}
              <Cursor />
            </p>
          </motion.div>
        )}

        {/* ── RESOLVED: full context ────────────────────────────────────────── */}
        {hasContext && (
          <>
            {/* News summary */}
            <motion.div {...fadeUp(0.1)}>
              <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-white/25 mb-1.5">
                Latest News
              </p>
              <p className="text-[13px] text-white/70 leading-relaxed tracking-tight font-light">
                {context.summary}
              </p>
            </motion.div>

            {/* Sentiment badge */}
            {!context.degraded && (
              <motion.div {...fadeUp(0.18)} className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold
                  px-2.5 py-1 rounded-full border tracking-tight ${sentimentColor(context.sentiment)}`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                  {context.sentiment} for YES
                </span>
              </motion.div>
            )}

            {/* Sources */}
            {context.sources.length > 0 && (
              <motion.div
                {...fadeUp(0.26)}
                className="space-y-1.5 pt-2 border-t border-white/[0.05]"
              >
                <p className="text-[9px] text-white/25 font-bold uppercase tracking-[0.14em] pt-1">
                  Sources
                </p>
                {context.sources.map((src, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.25, delay: 0.28 + i * 0.05 }}
                  >
                    {isUrl(src) ? (
                      <a
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-[11px] text-[#ff7a3d]/60
                          hover:text-[#ff7a3d] transition-colors tracking-tight group"
                        title={src}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2.5"
                          className="flex-shrink-0 opacity-60 group-hover:opacity-100">
                          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                        <span className="truncate">{sourceLabel(src)}</span>
                      </a>
                    ) : (
                      <p className="text-[11px] text-white/30 tracking-tight truncate">
                        {src}
                      </p>
                    )}
                  </motion.div>
                ))}
              </motion.div>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
