/**
 * GET /api/predictions/:slug
 *
 * Fetch a single Polymarket event by its slug.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getEventBySlug } from '@/src/lib/polymarket';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const event = await getEventBySlug(slug);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }
    return NextResponse.json({ event });
  } catch (err) {
    console.error('[Predictions API]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch event' },
      { status: 500 },
    );
  }
}
