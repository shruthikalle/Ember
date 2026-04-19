'use client';

/**
 * Cross-exchange arb analyst — SSE-powered.
 *
 * On "Scan arbs", opens a Server-Sent Events connection to /api/predictions/arb-stream.
 * The server scans Polymarket × Kalshi for profitable arbs and, for each, streams
 * a Claude commentary token-by-token. Each arb card has a "Place Polymarket leg"
 * button that posts the pre-built trade payload to /api/predictions/trade with
 * confirm=true — the server signs and executes against the CLOB.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// ─── Minimal markdown renderer ──────────────────────────────────────────────
//
// Supports the subset the arb analyst actually emits: paragraphs, bulleted
// and numbered lists, **bold**, *italic*, `inline code`, and [text](url) links.
// Small on purpose — no fenced code blocks, no headings, no tables.

function renderInline(text: string, keyBase: string): ReactNode[] {
  // Order matters: tokenize into links first, then inline emphasis/code.
  // Linkify [text](url) first so nothing inside the text gets mangled.
  const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const parts: { kind: 'text' | 'link'; text: string; href?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
    parts.push({ kind: 'link', text: m[1], href: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });

  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.kind === 'link' && p.href) {
      out.push(
        <a
          key={`${keyBase}-l-${i}`}
          href={p.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          {p.text}
        </a>,
      );
      return;
    }

    // Tokenize bold / italic / inline code inside plain text.
    // Regex captures: **bold** | *italic* | `code`
    const RE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
    const segs = p.text.split(RE);
    segs.forEach((seg, j) => {
      if (!seg) return;
      const key = `${keyBase}-t-${i}-${j}`;
      if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
        out.push(<strong key={key} className="font-semibold text-white">{seg.slice(2, -2)}</strong>);
      } else if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
        out.push(
          <code key={key} className="rounded bg-white/[0.06] px-1 py-[1px] font-mono text-[11.5px] text-white/90">
            {seg.slice(1, -1)}
          </code>,
        );
      } else if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) {
        out.push(<em key={key}>{seg.slice(1, -1)}</em>);
      } else {
        out.push(<span key={key}>{seg}</span>);
      }
    });
  });
  return out;
}

function renderMarkdown(src: string): ReactNode[] {
  // Split into blocks on blank lines so paragraphs and lists render independently.
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: ReactNode[] = [];

  blocks.forEach((block, bi) => {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return;

    // Bulleted list — every line starts with -, *, or •
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      out.push(
        <ul key={`b-${bi}`} className="list-none space-y-1 my-1.5">
          {lines.map((l, li) => {
            const content = l.replace(/^\s*[-*•]\s+/, '');
            return (
              <li key={`b-${bi}-${li}`} className="flex gap-2">
                <span className="text-white/40 shrink-0">•</span>
                <span>{renderInline(content, `b-${bi}-${li}`)}</span>
              </li>
            );
          })}
        </ul>,
      );
      return;
    }

    // Numbered list — every line starts with `1.`, `2.`, …
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      out.push(
        <ol key={`n-${bi}`} className="list-none space-y-1 my-1.5">
          {lines.map((l, li) => {
            const m = l.match(/^\s*(\d+)\.\s+(.*)$/);
            const num = m ? m[1] : `${li + 1}`;
            const content = m ? m[2] : l;
            return (
              <li key={`n-${bi}-${li}`} className="flex gap-2">
                <span className="text-white/40 shrink-0 tabular-nums">{num}.</span>
                <span>{renderInline(content, `n-${bi}-${li}`)}</span>
              </li>
            );
          })}
        </ol>,
      );
      return;
    }

    // Regular paragraph — join wrapped lines with a space, preserve as-is otherwise.
    out.push(
      <p key={`p-${bi}`} className="my-1.5 first:mt-0 last:mb-0">
        {renderInline(lines.join(' '), `p-${bi}`)}
      </p>,
    );
  });

  return out;
}

interface ArbPayload {
  id: string;
  similarity: number;
  polymarket: {
    slug: string;
    question: string;
    image: string | null;
    yesPrice: number | null;
    url: string;
  };
  kalshi: {
    ticker: string;
    title: string;
    subtitle: string | null;
    yesPrice: number | null;
    url: string;
  };
  arb: {
    polyYes: number;
    kalshiYes: number;
    spread: number;
    direction: {
      buyYesOn: 'polymarket' | 'kalshi';
      buyNoOn: 'polymarket' | 'kalshi';
    };
    costPerPair: number;
    pairs: number;
    deployedUsd: number;
    grossProfitUsd: number;
    polyFeesUsd: number;
    kalshiFeesUsd: number;
    netProfitUsd: number;
    roi: number;
  };
  trade: {
    marketSlug: string;
    action: 'BUY_YES' | 'BUY_NO';
    amountUsd: number;
  };
}

type TradeState =
  | { status: 'idle' }
  | { status: 'placing' }
  | { status: 'done'; orderID?: string; price: number; amountUsd: number }
  | { status: 'error'; message: string };

interface StreamState {
  status: 'idle' | 'scanning' | 'streaming' | 'done' | 'error';
  statusMsg: string;
  error: string;
  meta: {
    poly: number;
    kalshi: number;
    profitable: number;
    rejected?: { prefilter: number; gate: number };
    survivors?: number;
  } | null;
  arbs: ArbPayload[];
  commentary: Record<string, string>;
  tradeState: Record<string, TradeState>;
}

const INITIAL_STATE: StreamState = {
  status: 'idle',
  statusMsg: '',
  error: '',
  meta: null,
  arbs: [],
  commentary: {},
  tradeState: {},
};

function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export default function ArbAnalystPanel() {
  const [maxNotional, setMaxNotional] = useState('100');
  const [state, setState] = useState<StreamState>(INITIAL_STATE);
  const esRef = useRef<EventSource | null>(null);

  // Close the SSE connection on unmount so we don't leak a background stream.
  useEffect(() => () => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const start = useCallback(() => {
    esRef.current?.close();

    const notional = Math.max(5, parseFloat(maxNotional) || 100);
    const url = `/api/predictions/arb-stream?maxNotional=${notional}&topN=3`;

    setState({
      ...INITIAL_STATE,
      status: 'scanning',
      statusMsg: 'Scanning markets…',
    });

    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }

      setState((prev) => {
        switch (msg.type) {
          case 'status':
            return { ...prev, statusMsg: msg.message || '' };
          case 'meta': {
            const profitable = msg.profitable ?? 0;
            const survivors = msg.survivors ?? profitable;
            const rejected = msg.rejected ?? { prefilter: 0, gate: 0 };
            const totalRejected = (rejected.prefilter || 0) + (rejected.gate || 0);
            return {
              ...prev,
              meta: {
                poly: msg.scanned?.poly ?? 0,
                kalshi: msg.scanned?.kalshi ?? 0,
                profitable,
                rejected,
                survivors,
              },
              status: 'streaming',
              statusMsg:
                survivors === 0
                  ? profitable === 0
                    ? 'No profitable pairs right now.'
                    : `${profitable} profitable pair${profitable === 1 ? '' : 's'} — all rejected by equivalence check.`
                  : `${survivors} true arb${survivors === 1 ? '' : 's'} passed equivalence check${totalRejected ? ` (${totalRejected} rejected)` : ''} — streaming…`,
            };
          }
          case 'arb': {
            const arb = msg.arb as ArbPayload;
            if (!arb) return prev;
            return {
              ...prev,
              arbs: [...prev.arbs, arb],
              commentary: { ...prev.commentary, [arb.id]: '' },
              tradeState: { ...prev.tradeState, [arb.id]: { status: 'idle' } },
            };
          }
          case 'token': {
            const id = msg.id as string | undefined;
            const text = msg.text as string | undefined;
            if (!id || !text) return prev;
            return {
              ...prev,
              commentary: { ...prev.commentary, [id]: (prev.commentary[id] || '') + text },
            };
          }
          case 'arb_done':
            return prev;
          case 'done':
            es.close();
            esRef.current = null;
            return { ...prev, status: 'done', statusMsg: prev.statusMsg || 'Scan complete.' };
          case 'error':
            es.close();
            esRef.current = null;
            return { ...prev, status: 'error', error: msg.message || 'Stream error' };
          default:
            return prev;
        }
      });
    };

    es.onerror = () => {
      // EventSource emits onerror on normal close too — only flag if we weren't done.
      setState((prev) => {
        if (prev.status === 'done' || prev.status === 'error') return prev;
        es.close();
        esRef.current = null;
        return { ...prev, status: 'error', error: 'Connection to arb stream lost.' };
      });
    };
  }, [maxNotional]);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setState((prev) => ({ ...prev, status: 'done', statusMsg: 'Stopped.' }));
  }, []);

  const placeTrade = useCallback(async (arb: ArbPayload) => {
    setState((prev) => ({
      ...prev,
      tradeState: { ...prev.tradeState, [arb.id]: { status: 'placing' } },
    }));

    try {
      const res = await fetch('/api/predictions/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketSlug: arb.trade.marketSlug,
          action: arb.trade.action,
          amountUsd: arb.trade.amountUsd,
          confirm: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setState((prev) => ({
        ...prev,
        tradeState: {
          ...prev.tradeState,
          [arb.id]: {
            status: 'done',
            orderID: data?.result?.orderID,
            price: data?.trade?.price ?? 0,
            amountUsd: data?.trade?.amountUsd ?? arb.trade.amountUsd,
          },
        },
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((prev) => ({
        ...prev,
        tradeState: {
          ...prev.tradeState,
          [arb.id]: { status: 'error', message: msg },
        },
      }));
    }
  }, []);

  const scanning = state.status === 'scanning' || state.status === 'streaming';

  return (
    <section className="panel glow-accent" style={{ padding: '20px 22px' }}>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <div className="label mb-1" style={{ color: 'var(--color-accent)' }}>
            Arb analyst
          </div>
          <h3 className="text-[20px] leading-tight tracking-tight font-semibold text-white">
            Polymarket × Kalshi, live
          </h3>
          <p className="mt-1 text-[12.5px] text-[var(--color-text-dim)] max-w-lg leading-relaxed">
            Scans matched markets, filters for profitable spreads after fees, then streams an
            LLM take on each with executable Polymarket quotes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-[var(--color-text-mute)] uppercase tracking-wider">
            Size
          </label>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-white/40">$</span>
            <input
              type="number"
              min={5}
              step={5}
              value={maxNotional}
              onChange={(e) => setMaxNotional(e.target.value)}
              disabled={scanning}
              className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-5 pr-2 py-1.5 text-[12.5px] text-white focus:outline-none focus:border-white/20 disabled:opacity-50"
            />
          </div>
          {scanning ? (
            <button
              onClick={stop}
              className="btn-secondary text-[12.5px]"
              style={{ padding: '6px 14px' }}
            >
              Stop
            </button>
          ) : (
            <button
              onClick={start}
              className="btn-primary text-[12.5px]"
              style={{ padding: '6px 16px' }}
            >
              Scan arbs
            </button>
          )}
        </div>
      </div>

      {(state.statusMsg || state.meta) && (
        <div className="flex items-center gap-3 text-[11.5px] text-[var(--color-text-mute)] mb-4">
          {scanning && (
            <span className="w-2 h-2 rounded-full bg-[#ff7a3d] animate-pulse" />
          )}
          <span>{state.statusMsg}</span>
          {state.meta && state.status !== 'scanning' && (
            <span className="ml-auto tabular-nums">
              {state.meta.poly} Polymarket × {state.meta.kalshi} Kalshi
              {state.meta.rejected && (state.meta.rejected.prefilter + state.meta.rejected.gate) > 0 && (
                <>
                  {' · '}
                  <span className="text-amber-300/80">
                    {state.meta.rejected.prefilter + state.meta.rejected.gate} false-arb{state.meta.rejected.prefilter + state.meta.rejected.gate === 1 ? '' : 's'} filtered
                  </span>
                </>
              )}
            </span>
          )}
        </div>
      )}

      {state.status === 'error' && state.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300 mb-4">
          {state.error}
        </div>
      )}

      <div className="space-y-3">
        {state.arbs.map((arb) => {
          const ts = state.tradeState[arb.id] || { status: 'idle' };
          const polyAction = arb.trade.action;
          const accent =
            arb.arb.direction.buyYesOn === 'polymarket'
              ? 'text-emerald-400'
              : 'text-red-300';
          // Guard: if the analyst flags the pair as not a true arb, the
          // matcher paired semantically-similar markets that actually resolve
          // on different events. Block the one-click execute path.
          const commentaryLower = (state.commentary[arb.id] || '').toLowerCase();
          const flaggedNotArb =
            /\bnot\s+a\s+(true\s+)?arb\b/.test(commentaryLower) ||
            /\bfalse\s+arb\b/.test(commentaryLower) ||
            /\bcorrelation\s+bet\b/.test(commentaryLower) ||
            /\bresolution\s+mismatch\b/.test(commentaryLower) ||
            /\bnot\s+identical\b/.test(commentaryLower);

          return (
            <div
              key={arb.id}
              className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 hover:bg-white/[0.03] transition-colors"
            >
              {/* Header — the two venues + net profit */}
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-mute)] mb-1">
                    Polymarket
                  </div>
                  <a
                    href={arb.polymarket.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13.5px] text-white font-medium hover:text-[var(--color-accent)] line-clamp-2"
                  >
                    {arb.polymarket.question}
                  </a>
                  <div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-mute)] mt-2.5 mb-1">
                    Kalshi
                  </div>
                  <a
                    href={arb.kalshi.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] text-white/80 hover:text-[var(--color-accent)] line-clamp-2"
                  >
                    {arb.kalshi.title}
                    {arb.kalshi.subtitle ? ` — ${arb.kalshi.subtitle}` : ''}
                  </a>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10.5px] uppercase tracking-wider text-[var(--color-text-mute)]">
                    Net P&amp;L
                  </div>
                  <div className="text-[18px] font-semibold text-emerald-400 tabular-nums">
                    +{usd(arb.arb.netProfitUsd)}
                  </div>
                  <div className="text-[10.5px] text-[var(--color-text-mute)] tabular-nums">
                    {pct(arb.arb.roi, 2)} ROI · {pct(arb.similarity, 0)} match
                  </div>
                </div>
              </div>

              {/* Quotes */}
              <div className="grid grid-cols-2 gap-3 mb-3 text-[11.5px]">
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-mute)]">
                    Polymarket YES
                  </div>
                  <div className="text-[15px] text-white tabular-nums mt-0.5">
                    {pct(arb.arb.polyYes, 1)}
                  </div>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-mute)]">
                    Kalshi YES
                  </div>
                  <div className="text-[15px] text-white tabular-nums mt-0.5">
                    {pct(arb.arb.kalshiYes, 1)}
                  </div>
                </div>
              </div>

              {/* Plan */}
              <div className="rounded-lg bg-white/[0.02] border border-white/[0.05] px-3 py-2 text-[11.5px] leading-relaxed mb-3">
                <span className={`font-semibold ${accent}`}>
                  {polyAction === 'BUY_YES' ? 'Buy YES' : 'Buy NO'}
                </span>{' '}
                on Polymarket for {usd(arb.trade.amountUsd)}
                {' · '}
                <span className="font-semibold text-white/80">
                  Buy {arb.arb.direction.buyYesOn === 'kalshi' ? 'YES' : 'NO'}
                </span>{' '}
                on Kalshi ({arb.arb.pairs.toLocaleString()} contracts){' '}
                <span className="text-[var(--color-text-mute)]">
                  · fees ~{usd(arb.arb.polyFeesUsd + arb.arb.kalshiFeesUsd)}
                </span>
              </div>

              {/* LLM commentary (markdown-rendered) */}
              <div className="rounded-lg bg-black/40 border border-white/[0.05] px-3 py-2.5 text-[12.5px] text-white/85 leading-relaxed min-h-[3.5em]">
                {state.commentary[arb.id] ? (
                  renderMarkdown(state.commentary[arb.id])
                ) : (
                  <span className="text-white/30 italic">Analyst is thinking…</span>
                )}
              </div>

              {/* False-arb warning — shown above the trade CTA when flagged */}
              {flaggedNotArb && ts.status !== 'done' && (
                <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 text-[11.5px] text-amber-200 leading-relaxed">
                  Analyst flagged a resolution mismatch — these markets may not settle together.
                  Execute only if you understand the correlation, not as a locked arb.
                </div>
              )}

              {/* Trade action */}
              <div className="mt-3 flex items-center gap-2.5">
                {ts.status === 'idle' && (
                  <button
                    onClick={() => placeTrade(arb)}
                    disabled={flaggedNotArb}
                    className="btn-primary text-[12.5px] disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ padding: '7px 14px' }}
                  >
                    {flaggedNotArb ? 'Blocked — not a true arb' : `Place Polymarket leg (${polyAction === 'BUY_YES' ? 'YES' : 'NO'}, ${usd(arb.trade.amountUsd)})`}
                  </button>
                )}
                {ts.status === 'placing' && (
                  <span className="inline-flex items-center gap-2 text-[12px] text-[var(--color-text-dim)]">
                    <span className="w-3 h-3 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                    Placing order on Polymarket…
                  </span>
                )}
                {ts.status === 'done' && (
                  <span className="text-[12px] text-emerald-400">
                    Filled {usd(ts.amountUsd)} @ {pct(ts.price, 1)}
                    {ts.orderID ? ` · order ${ts.orderID.slice(0, 8)}…` : ''}
                  </span>
                )}
                {ts.status === 'error' && (
                  <span className="text-[12px] text-red-300">Failed: {ts.message}</span>
                )}
                <a
                  href={arb.polymarket.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[var(--color-text-mute)] hover:text-white/70 ml-auto"
                >
                  view on Polymarket ↗
                </a>
              </div>
            </div>
          );
        })}

        {state.arbs.length === 0 && state.status === 'idle' && (
          <div className="text-[12.5px] text-[var(--color-text-mute)] leading-relaxed">
            Click <span className="text-white font-medium">Scan arbs</span> to find profitable
            cross-exchange spreads. The analyst streams live commentary and a one-click Polymarket
            execution.
          </div>
        )}
      </div>
    </section>
  );
}
