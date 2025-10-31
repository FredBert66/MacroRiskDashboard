export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const origin = new URL(req.url).origin;
    const token = (process.env.REFRESH_TOKEN ?? '').trim();

    const url = `${origin}/api/refresh${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(token ? { 'x-refresh-token': token } : {}),
        'x-internal-refresh': '1', // possible internal-allow (step 2)
      },
      cache: 'no-store',
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'refresh-now failed' }, { status: 500 });
  }
}
