/**
 * Context Engine Analyst
 *
 * Given a market title, fetches recent Google News RSS articles and returns
 * a qualitative summary with sentiment and source links. Does NOT estimate
 * probabilities, calculate edges, or recommend trades.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** The structured output of the context engine analyst. */
export interface ContextAnalystResult {
  /** 2–3 sentence summary of the current news landscape for this market. */
  summary: string;
  /** Overall sentiment regarding the YES outcome. */
  sentiment: 'Positive' | 'Negative' | 'Mixed';
  /** URLs or source names found during web search. */
  sources: string[];
  /** True when the call failed or produced a degraded / fallback result. */
  degraded?: boolean;
}

export interface ContextAnalystOptions {
  /** Called with progress label strings during the news-fetch phase. */
  onProgress?: (msg: string) => void;
  /**
   * Called once with the full summary text so the streaming UI can display it.
   */
  onSummaryChunk?: (chunk: string) => void;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

const CONTEXT_TTL_MS = 10 * 60_000; // 10 minutes
const contextMemoryCache = new Map<string, { data: ContextAnalystResult; at: number }>();

function contextCacheKey(title: string): string {
  // v3 prefix busts any cached entries that contained raw HTML
  return `ctx3:${title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function hasHtml(s: string): boolean {
  return /<[a-z]/i.test(s);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function analyzeMarket(
  marketTitle: string,
  options?: ContextAnalystOptions,
): Promise<ContextAnalystResult> {
  const cacheKey = contextCacheKey(marketTitle);

  // Memory cache hit — reject if summary contains HTML (old bad entry)
  const memHit = contextMemoryCache.get(cacheKey);
  if (memHit && Date.now() - memHit.at < CONTEXT_TTL_MS && !hasHtml(memHit.data.summary)) {
    options?.onProgress?.('Using cached analysis…');
    options?.onSummaryChunk?.(memHit.data.summary);
    return memHit.data;
  }

  // Disk cache hit — same HTML guard
  try {
    const { getSimilarCache } = await import('@/src/lib/db');
    const diskHit = getSimilarCache(cacheKey, CONTEXT_TTL_MS) as ContextAnalystResult | null;
    if (diskHit && !diskHit.degraded && diskHit.summary && !hasHtml(diskHit.summary)) {
      contextMemoryCache.set(cacheKey, { data: diskHit, at: Date.now() });
      options?.onProgress?.('Using cached analysis…');
      options?.onSummaryChunk?.(diskHit.summary);
      return diskHit;
    }
  } catch { /* cache unavailable — live fetch */ }

  options?.onProgress?.('Searching latest news...');

  try {
    const articles = await fetchGoogleNews(marketTitle);

    if (articles.length === 0) {
      const result = degraded('No recent news found for this market.');
      return result;
    }

    // Build a clean summary from the top article headlines only.
    // Google News descriptions are raw HTML so we skip them entirely.
    // stripHtml applied defensively to titles too — some feeds embed entities.
    const top = articles.slice(0, 3);
    const cleanTitle = (raw: string) =>
      stripHtml(raw).replace(/\s*-\s*[^-]+$/, '').trim();
    const summaryParts = top.map((a) => cleanTitle(a.title));
    const summary = summaryParts.filter(Boolean).join(' • ').slice(0, 800);

    // Extract "Source Name" from "Headline - Source Name" trailing pattern
    const sources = articles.slice(0, 8).map((a) => {
      const plain = stripHtml(a.title);
      const sourceMatch = plain.match(/\s*-\s*([^-]+)$/);
      return sourceMatch ? sourceMatch[1].trim() : '';
    }).filter(Boolean);
    const sentiment = inferSentiment(summary);

    const result: ContextAnalystResult = { summary, sentiment, sources };

    // Deliver to streaming UI
    options?.onSummaryChunk?.(summary);
    options?.onProgress?.('Done.');

    await cacheContextResult(cacheKey, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[context-analyst] News fetch failed:', msg);
    return degraded('News analysis unavailable — please try again.');
  }
}

async function cacheContextResult(key: string, result: ContextAnalystResult): Promise<void> {
  if (result.degraded || !result.summary) return;
  contextMemoryCache.set(key, { data: result, at: Date.now() });
  try {
    const { putSimilarCache } = await import('@/src/lib/db');
    putSimilarCache(key, result);
  } catch { /* non-fatal */ }
}

// ─── Google News RSS ─────────────────────────────────────────────────────────

interface NewsArticle {
  title: string;
  link: string;
  description: string;
}

/**
 * Fetches up to 8 recent articles from Google News RSS for the given query.
 * No API key required — uses the public RSS endpoint.
 */
async function fetchGoogleNews(query: string): Promise<NewsArticle[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmberBot/1.0)' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Google News RSS returned ${res.status}`);

  const xml = await res.text();
  return parseRssItems(xml).slice(0, 8);
}

/** Extracts <item> blocks from RSS XML using lightweight regex parsing. */
function parseRssItems(xml: string): NewsArticle[] {
  const items: NewsArticle[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title       = extractTag(block, 'title');
    const link        = extractTag(block, 'link') || extractTag(block, 'guid');
    const description = stripHtml(extractTag(block, 'description'));

    if (title) {
      items.push({ title: stripHtml(title), link: link ?? '', description });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
         ?? xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const POSITIVE_WORDS = /\b(surge|soar|rise|gain|boost|win|approve|pass|confirm|support|strong|bullish|victory|success|beat|exceed)\b/i;
const NEGATIVE_WORDS = /\b(fall|drop|decline|fail|reject|block|ban|loss|weak|bearish|crisis|concern|risk|warn|miss|delay)\b/i;

function inferSentiment(text: string): 'Positive' | 'Negative' | 'Mixed' {
  const pos = (text.match(POSITIVE_WORDS) ?? []).length;
  const neg = (text.match(NEGATIVE_WORDS) ?? []).length;
  if (pos > neg + 1) return 'Positive';
  if (neg > pos + 1) return 'Negative';
  return 'Mixed';
}

function degraded(reason: string): ContextAnalystResult {
  return {
    summary: reason,
    sentiment: 'Mixed',
    sources: [],
    degraded: true,
  };
}
