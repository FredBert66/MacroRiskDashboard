// src/lib/fetchers/te.ts

const TE_ORIGIN = 'https://api.tradingeconomics.com';

function buildUrl(segments: string[], qs: Record<string, string> = {}) {
  const url = new URL(TE_ORIGIN);
  // join and encode each path segment
  const base = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = [base, ...segments.map(s => encodeURIComponent(s))].join('/');
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  return url;
}

async function te(segments: string[], qs: Record<string, string> = {}) {
  const user = process.env.TE_USER;
  const key = process.env.TE_KEY;
  if (!user || !key) throw new Error('TE_USER/TE_KEY env vars missing');

  const url = buildUrl(segments, { c: `${user}:${key}`, ...qs });

  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`TE ${url.pathname} ${r.status}`);
  return r.json();
}

// Convenience wrappers
export const tePMI = (country: string) => te(['pmi', country]);
export const teUR  = (country: string) => te(['unemployment rate', country]);

export { te };
