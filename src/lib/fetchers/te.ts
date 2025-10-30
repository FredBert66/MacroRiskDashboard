// src/lib/fetchers/te.ts

export const TE_ORIGIN = 'https://api.tradingeconomics.com';

function buildUrl(path: string, qs: Record<string, string>) {
  const url = new URL(path, TE_ORIGIN);
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  // format=json improves consistency
  if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');
  return url;
}

async function fetchTE(url: URL) {
  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) {
    // include short body to help debug
    const body = await r.text().catch(() => '');
    throw new Error(`TE ${url.pathname}${url.search} ${r.status} ${body.slice(0,120)}`);
  }
  return r.json();
}

/**
 * Try with provided creds; on 401, fall back to guest:guest so you can proceed.
 */
async function te(path: string, qs: Record<string, string>) {
  const user = (process.env.TE_USER ?? '').trim();
  const key  = (process.env.TE_KEY ?? '').trim();

  // 1) Try with your credentials if present
  if (user && key) {
    const url = buildUrl(path, { c: `${user}:${key}`, ...qs });
    try {
      return await fetchTE(url);
    } catch (e: any) {
      // if not an auth error, rethrow
      if (!String(e?.message || '').includes(' 401')) throw e;
      // else fall through to guest
    }
  }

  // 2) Fallback to guest:guest
  const guestUrl = buildUrl(path, { c: 'guest:guest', ...qs });
  return fetchTE(guestUrl);
}

/** Use Indicators endpoint for both PMI and Unemployment Rate */
export const tePMI = (country: string) =>
  te('/indicators', { country, indicator: 'PMI' });

export const teUR = (country: string) =>
  te('/indicators', { country, indicator: 'Unemployment Rate' });

export { te };
