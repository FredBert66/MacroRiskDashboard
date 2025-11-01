export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';
import { computeScore, toSignal } from '../../../lib/normalize';

// lightweight FRED fetcher for a point-in-time
async function fredAt(seriesId: string, asOf: string): Promise<number> {
  const key = (process.env.FRED_KEY ?? '').trim();
  if (!key) throw new Error('FRED_KEY missing');
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_end', asOf);
  const r = await fetch(url, { next: { revalidate: 0 } });
  const j = await r.json();
  const obs = j?.observations ?? [];
  if (!obs.length) throw new Error(`FRED ${seriesId} empty at ${asOf}`);
  // pick the last observation on/before asOf
  for (let i = obs.length - 1; i >= 0; i--) {
    const v = Number((obs[i]?.value ?? '').toString().replace(/[% ,]/g,''));
    if (Number.isFinite(v)) return v;
  }
  throw new Error(`FRED ${seriesId} bad values at ${asOf}`);
}

function quarterEnds(nQuarters = 12): { period: string; asOf: string }[] {
  const out: {period:string;asOf:string}[] = [];
  const d = new Date();
  const qEndMonth = [3,6,9,12]; // Mar, Jun, Sep, Dec
  for (let i = 0; i < nQuarters; i++) {
    const m = d.getMonth()+1, y = d.getFullYear();
    const qm = m<=3?3:m<=6?6:m<=9?9:12;
    const asOf = new Date(y, qm-1, 28); // safe day near month-end
    // move back i quarters
    asOf.setMonth(asOf.getMonth() - 3*i);
    const yy = asOf.getFullYear();
    const mm = asOf.getMonth()+1;
    const q = mm<=3?'Q1':mm<=6?'Q2':mm<=9?'Q3':'Q4';
    const lastDay = new Date(yy, mm, 0).getDate();
    const end = new Date(yy, mm-1, lastDay);
    out.push({ period: `${yy} ${q}`, asOf: end.toISOString().slice(0,10) });
  }
  // oldest→newest
  return out.reverse();
}

export async function POST(req: Request) {
  try {
    // simple auth reuse: require same token as refresh (if set)
    const required = (process.env.REFRESH_TOKEN ?? '').trim();
    const qsToken = new URL(req.url).searchParams.get('token')?.trim() ?? '';
    if (required && qsToken !== required)
      return NextResponse.json({ ok:false, error:'unauthorized' }, { status:401 });

    const rows = await readRows();
    const periods = quarterEnds(12);

    for (const { period, asOf } of periods) {
      // FRED series IDs:
      // HY OAS US: BAMLH0A0HYM2  | Europe HY OAS: BAMLHE00EHYIOAS
      // NFCI: NFCI               | DXY (broad): TWEXBGSMTH
      // UNRATE (US unemployment): UNRATE
      const [usHy, euHy, nfci, dxy, urUS] = await Promise.all([
        fredAt('BAMLH0A0HYM2', asOf),
        fredAt('BAMLHE00EHYIOAS', asOf),
        fredAt('NFCI', asOf),
        fredAt('TWEXBGSMTH', asOf),
        fredAt('UNRATE', asOf),
      ]);

      const pmiNeutral = 50;
      const mk = (region:string, hy:number, fci:number, pmi:number, dxyv:number, ur:number, bb:number, def:number) => {
        const riskScore = computeScore({ hyOAS: hy, fci, pmi, dxy: dxyv, bookBill: bb, ur });
        return { period, region, hyOAS: hy, fci, pmi, dxy: dxyv, bookBill: bb, defaults: def, unemployment: ur, riskScore, signal: toSignal(riskScore) };
      };

      // region rows (PMI=50 placeholder; you can enhance later)
      const usa = mk('USA', usHy, nfci, pmiNeutral, dxy, urUS, 1.06, 2.0);
      const eur = mk('Europe', euHy, nfci, pmiNeutral, dxy, 6.0, 1.04, 2.0);
      const chn = mk('China', 380, 0.05, pmiNeutral, dxy, 6.0, 1.02, 3.0);
      const ind = mk('India', 360, -0.25, pmiNeutral, dxy, 6.0, 1.08, 1.2);
      const la  = mk('Latin America', 450, -0.10, pmiNeutral, dxy, 6.0, 1.02, 3.0);

      // upsert/replace period+region
      const up = (row:any) => {
        const i = rows.findIndex((r:any)=> r.period===row.period && r.region===row.region);
        if (i>=0) rows[i]=row; else rows.push(row);
      };
      [usa, eur, chn, ind, la].forEach(up);

      // Global IMF-weighted
      const W = weights as Record<'USA'|'Europe'|'China'|'India'|'Latin America', number>;
      const get = (r:string)=> rows.find((x:any)=> x.period===period && x.region===r)!;
      const rUS=get('USA'), rEU=get('Europe'), rCN=get('China'), rIN=get('India'), rLA=get('Latin America');
      const wsum = (k:'hyOAS'|'fci'|'pmi'|'dxy'|'bookBill'|'unemployment') =>
        rUS[k]*W['USA'] + rEU[k]*W['Europe'] + rCN[k]*W['China'] + rIN[k]*W['India'] + rLA[k]*W['Latin America'];
      const g = { hyOAS: wsum('hyOAS'), fci: wsum('fci'), pmi: wsum('pmi'), dxy: rUS.dxy, bookBill: wsum('bookBill'), unemployment: wsum('unemployment') };
      const gScore = computeScore({ hyOAS:g.hyOAS, fci:g.fci, pmi:g.pmi, dxy:g.dxy, bookBill:g.bookBill, ur:g.unemployment });
      const gRow = { period, region:'Global', ...g, defaults:2.0, riskScore:gScore, signal: toSignal(gScore) };
      up(gRow);
    }

    await writeRows(rows);
    return NextResponse.json({ ok:true, backfilled: periods.map(p=>p.period) });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: String(e?.message||e) }, { status:500 });
  }
}

export async function GET(req: Request) { return POST(req); }
