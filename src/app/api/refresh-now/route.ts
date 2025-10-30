import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

export async function POST() {
  const h = headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('host') ?? '';
  const token = process.env.REFRESH_TOKEN ?? '';

  // call refresh without query param; send the token in a header
  const url = `${proto}://${host}/api/refresh`;
  const res = await fetch(url, { method: 'POST', headers: { 'x-refresh-token': token } });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
  const url = `${proto}://${host}/api/refresh?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
