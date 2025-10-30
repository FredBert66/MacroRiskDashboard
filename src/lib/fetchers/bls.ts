export async function bls(series: string[], start=2021, end=2026) {
  const key = process.env.BLS_KEY;
  if (!key) throw new Error('BLS_KEY env var missing');
  const r = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ seriesid: series, startyear: `${start}`, endyear: `${end}`, registrationkey: key })
  });
  if (!r.ok) throw new Error(`BLS ${r.status}`);
  return r.json();
}
