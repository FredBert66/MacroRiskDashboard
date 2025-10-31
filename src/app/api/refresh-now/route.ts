export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const token  = (process.env.REFRESH_TOKEN ?? '').trim();
  const tlen   = token ? token.length : 0;

  // helper: call refresh with given options and bubble JSON
  const call = async (opts: { header?: boolean; query?: boolean; internal?: boolean }) => {
    const url = `${origin}/api/refresh?debug=1${opts.query && token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const headers: Record<string,string> = { };
    if (opts.header && token) headers['x-refresh-token'] = token;
    if (opts.internal) headers['x-internal-refresh'] = '1';
    const res = await fetch(url, { method: 'POST', headers, cache: 'no-store' });
    const body = await res.json().catch(() => ({ ok:false, error:'no-json' }));
    return { status: res.status, body, used: { header: !!opts.header, query: !!opts.query, internal: !!opts.internal } };
  };

  try {
    // Try 1: header + query + internal marker
    let r = await call({ header: true, query: true, internal: true });
    if (r.status === 401) {
      // Try 2: query + internal only
      r = await call({ header: false, query: true, internal: true });
    }
    if (r.status === 401) {
      // Try 3: header + internal only
      r = await call({ header: true, query: false, internal: true });
    }

    // Respond with whatever we got, plus diagnostics so you can see why
    return NextResponse.json(
      { ...r.body, diag: { status: r.status, tried: r.used, tokenLen: tlen } },
      { status: r.status }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok:false, error: e?.message ?? 'refresh-now failed', tokenLen: tlen },
      { status: 500 }
    );
  }
}
