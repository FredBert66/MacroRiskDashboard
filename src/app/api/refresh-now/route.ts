export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

async function callRefresh(origin: string, token: string | null, opts: { header: boolean; query: boolean; internal: boolean }) {
  const url = `${origin}/api/refresh?debug=1${opts.query && token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const headers: Record<string,string> = {};
  if (opts.header && token) headers['x-refresh-token'] = token;
  if (opts.internal) headers['x-internal-refresh'] = '1';

  const res = await fetch(url, { method: 'POST', headers, cache: 'no-store', redirect: 'manual' });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text(); // read once

  // Try to parse JSON only if it's JSON; otherwise return text snippet
  let body: any = null;
  if (contentType.includes('application/json')) {
    try { body = JSON.parse(text); } catch { /* fallthrough */ }
  }

  return {
    status: res.status,
    contentType,
    isJson: Boolean(body),
    body: body ?? { ok:false, error:'non-json', snippet: text.slice(0,200) },
    tried: opts,
  };
}

export async function POST(req: Request) {
  try {
    const origin = new URL(req.url).origin;
    const token = (process.env.REFRESH_TOKEN ?? '').trim() || null;

    // Try header+query+internal → query+internal → header+internal
    const attempts = [
      { header: true,  query: true,  internal: true },
      { header: false, query: true,  internal: true },
      { header: true,  query: false, internal: true },
    ];

    let last: any = null;
    for (const a of attempts) {
      const r = await callRefresh(origin, token, a);
      last = r;
      if (r.status !== 401 && r.status !== 403 && r.status !== 307 && r.status !== 308) {
        // Anything other than auth/redirect: return it (success or clear failure)
        return NextResponse.json({ ...r.body, diag: { status: r.status, tried: r.tried, json: r.isJson, ct: r.contentType } }, { status: r.status });
      }
    }

    // Still unauthorized/redirect → return last diagnostics
    return NextResponse.json(
      { ...last.body, diag: { status: last.status, tried: last.tried, json: last.isJson, ct: last.contentType } },
      { status: last.status }
    );
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message ?? 'refresh-now failed' }, { status: 500 });
  }
}

// Optional: allow GET so you can trigger from the browser if needed
export async function GET(req: Request) {
  return POST(req);
}
