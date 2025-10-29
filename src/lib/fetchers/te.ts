const TE = 'https://api.tradingeconomics.com';

export async function te(path: string, qs: Record<string,string> = {}) {
  const url = new URL(`${TE}/${path}`);
  url.searchParams.set('c', `${process.env.TE_USER}:${process.env.TE_KEY}`);
  Object.entries(qs).forEach(([k,v]) => url.searchParams.set(k,v));
  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`TE ${path} ${r.status}`);
  return r.json();
}
// Convenience wrappers
export const tePMI = (country: string) => te(`pmi/${encodeURIComponent(country)}`);
export const teUR  = (country: string) => te(`unemployment rate/${encodeURIComponent(country)}`);
