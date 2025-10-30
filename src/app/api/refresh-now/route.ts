import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

export async function POST() {
  // Build absolute URL to your own /api/refresh endpoint
  const h = headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('host') ?? '';
  const token = process.env.REFRESH_TOKEN ?? '';

  const url = `${proto}://${host}/api/refresh?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
