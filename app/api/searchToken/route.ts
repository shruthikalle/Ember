import { NextRequest, NextResponse } from 'next/server';
import { TokenInfo } from '@/src/lib/tokens';

/**
 * POST /api/searchToken
 * Search for token address using LLM (backend)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tokenSymbol } = body as { tokenSymbol: string };

    if (!tokenSymbol || typeof tokenSymbol !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "tokenSymbol" field' },
        { status: 400 }
      );
    }

    console.log('[API SearchToken] Searching for token:', tokenSymbol);

    // Call backend to search for token
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000';
    const searchResponse = await fetch(`${backendUrl}/searchToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenSymbol }),
    });

    if (!searchResponse.ok) {
      const errorData = await searchResponse.json();
      console.error('[API SearchToken] Backend search failed:', errorData);
      return NextResponse.json(
        { error: errorData.error || 'Failed to search for token' },
        { status: searchResponse.status }
      );
    }

    const tokenInfo = await searchResponse.json() as TokenInfo;
    console.log('[API SearchToken] ✅ Token found:', tokenInfo);

    return NextResponse.json(tokenInfo);
  } catch (error) {
    console.error('[API SearchToken] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
