import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const token = process.env.REFRESH_TOKEN ?? '';
    const origin = new URL(req.url).origin; // robust: works locally & on Vercel

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
