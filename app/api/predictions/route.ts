/**
 * GET /api/predictions
 *
 * Fetch active prediction markets from Polymarket.
 *
 * Query params:
 *   - limit   (default 20)
 *   - offset  (default 0)
 *   - tag_id  (optional — filter by category)
 *   - q       (optional — text search)
 *   - tags    (optional — "true" to include tag list)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getActiveEvents,
  searchMarkets,
  getTags,
} from '@/src/lib/polymarket';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get('q')?.trim();
  const limit = parseInt(params.get('limit') || '20', 10);
  const offset = parseInt(params.get('offset') || '0', 10);
  const tag_id = params.get('tag_id') || undefined;
  const includeTags = params.get('tags') === 'true';

  try {
    // If text search, use market-level search
    if (q) {
      const markets = await searchMarkets(q, limit);
      return NextResponse.json({ markets, query: q });
    }

    // Otherwise fetch events (grouped markets)
    const events = await getActiveEvents({ limit, offset, tag_id });

    const response: Record<string, unknown> = { events };

    // Optionally include tags for filter UI
    if (includeTags) {
      const tags = await getTags();
      response.tags = tags;
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error('[Predictions API]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch markets' },
      { status: 500 },
    );
  }
}
