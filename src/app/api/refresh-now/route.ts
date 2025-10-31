export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const origin = new URL(req.url).origin;

    // Read token from env (must be set in Vercel → Project → Settings → Environment Variables)
    const token = (process.env.REFRESH_TOKEN ?? '').trim();

    // Call your refresh endpoint and pass the token in a header
    const res = await fetch(`${origin}/api/refresh`, {
      method: 'POST',
      headers: token ? { 'x-refresh-token': token } : undefined,
      cache: 'no-store',
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'refresh-now failed' }, { status: 500 });
  }
}
