export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
// import the existing refresh route handler directly (relative path is important)
import { POST as refreshPOST } from '../refresh/route';

export async function POST() {
  try {
    // Build a Request object that the refresh handler expects.
    // We set x-internal-refresh so authorize() will allow it without a token.
    const fakeReq = new Request('http://internal/api/refresh?debug=1', {
      method: 'POST',
      headers: { 'x-internal-refresh': '1' },
    });

    // Call the refresh handler directly (no network, no middleware).
    const res = await refreshPOST(fakeReq);
    return res; // this is already a NextResponse with JSON
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

// Optional: allow GET so you can hit it in the browser for testing
export async function GET() {
  return POST();
}
