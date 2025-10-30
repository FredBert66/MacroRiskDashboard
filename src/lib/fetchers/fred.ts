const FRED = 'https://api.stlouisfed.org/fred/series/observations';

async function fetchJSON(url: URL) {
  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`FRED ${url.searchParams.get('series_id')} ${r.status}`);
  return r.json();
}

export async function fred(series: string, params: Record<string,string> = {}) {
  const key = process.env.FRED_KEY;
  if (!key) throw new Error('FRED_KEY env var missing');
  const url = new URL(FRED);
  url.searchParams.set('series_id', series);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  return fetchJSON(url);
}

export const getUsHyOAS = (start='2021-01-01') => fred('BAMLH0A0HYM2',{ start_date: start });
export const getEuHyOAS = (start='2021-01-01') => fred('BAMLHE00EHYIOAS',{ start_date: start });
export const getNFCI   = (start='2021-01-01') => fred('NFCI',{ start_date: start });
export const getUSD    = (start='2021-01-01') => fred('TWEXBGSMTH',{ start_date: start });
