export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const origin = new URL(req.url).origin;
    const token = (process.env.REFRESH_TOKEN ?? '').trim();

    // Call refresh with header + query + debug flag
    const url = `${origin}/api/refresh?debug=1${token ? `&token=${encodeURIComponent(token)}` : ''}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(token ? { 'x-refresh-token': token } : {}),
        'x-internal-refresh': '1',   // used by auth to allow trusted internal proxy
      },
      cache: 'no-store',
    });

    const data = await res.json().catch(() => ({}));
    // Bubble up the *actual* status + body so the UI shows the real reason
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'refresh-now failed' }, { status: 500 });
  }
}
