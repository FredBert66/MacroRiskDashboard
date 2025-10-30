// src/lib/fetchers/te.ts

const TE_ORIGIN = 'https://api.tradingeconomics.com';

function buildUrl(path: string, qs: Record<string, string>) {
  const url = new URL(path, TE_ORIGIN);
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  return url;
}

async function te(path: string, qs: Record<string, string>) {
  const user = process.env.TE_USER;
  const key  = process.env.TE_KEY;
  if (!user || !key) throw new Error('TE_USER/TE_KEY env vars missing');

  const url = buildUrl(path, { c: `${user}:${key}`, ...qs });
  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`TE ${url.pathname}${url.search} ${r.status}`);
  return r.json();
}

/** Use Indicators endpoint for both PMI and Unemployment Rate */
export const tePMI = (country: string) =>
  te('/indicators', { country, indicator: 'PMI' });

export const teUR = (country: string) =>
  te('/indicators', { country, indicator: 'Unemployment Rate' });

export { te };
