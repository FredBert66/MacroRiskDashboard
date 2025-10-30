const TE = 'https://api.tradingeconomics.com';

async function te(path: string, qs: Record<string,string> = {}) {
  const user = process.env.TE_USER;
  const key  = process.env.TE_KEY;
  if (!user || !key) throw new Error('TE_USER/TE_KEY env vars missing');

  const url = new URL(`${TE}/${path}`);
  url.searchParams.set('c', `${user}:${key}`); // TradingEconomics expects c=user:key
  Object.entries(qs).forEach(([k,v]) => url.searchParams.set(k,v));

  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`TE ${path} ${r.status}`);
  return r.json();
}

export const tePMI = (country: string) => te(`pmi/${encodeURIComponent(country)}`);
export const teUR  = (country: string) => te(`unemployment rate/${encodeURIComponent(country)}`);
