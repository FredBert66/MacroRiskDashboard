export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// RELATIVE imports (avoid alias issues on Vercel)
import { getUsHyOAS, getEuHyOAS, getNFCI, getUSD } from '../../../lib/fetchers/fred';
import { bls } from '../../../lib/fetchers/bls';
import { te } from '../../../lib/fetchers/te';
import { tePMI, teUR } from '../../../lib/fetchers/te';
import { computeScore, toSignal, quarter } from '../../../lib/normalize';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';

/** ---- helper types & utils (solve "unknown" errors) ---- **/
type FredObs = { value: string } ;
type FredResponse = { observations: FredObs[] };

type TeItem = { LatestValue?: string | number; Value?: string | number };
type TeArray = TeItem[];

function toNum(v: unknown, err = 'Expected number'): number {
  const n = typeof v === 'string' ? Number(v) : (typeof v === 'number' ? v : NaN);
  if (!Number.isFinite(n)) throw new Error(err);
  return n;
}
function last<T>(arr: T[], err = 'Empty array'): T {
  if (!arr || arr.length === 0) throw new Error(err);
  return arr[arr.length - 1];
}
function fredLatest(series: unknown, errName: string): number {
  const s = series as FredResponse;
  return toNum(last(s.observations, `${errName}: no observations`).value, `${errName}: bad value`);
}
function teTryExtract(arr: unknown): number | null {
  const a = arr as any[];
  if (!Array.isArray(a) || a.length === 0) return null;

  // scan from newest → oldest
  for (let i = a.length - 1; i >= 0; i--) {
    const it = a[i] ?? {};
    const candidates = [
      it.LatestValue,
      it.Value,
      it.value,
      it.Actual,
      it.Previous,
    ];
    for (const c of candidates) {
      const n =
        typeof c === 'number'
          ? c
          : typeof c === 'string'
          ? Number(c.replace(/[% ,]/g, ''))
          : NaN;
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// Try TE /indicators first; if no numeric values, fall back to /historical
async function teLatestOrHistorical(
  country: string,
  indicator: string,
  primary: unknown,
  errName: string
): Promise<number> {
  const fromPrimary = teTryExtract(primary);
  if (fromPrimary !== null) return fromPrimary;

  // Fallback: historical series (usually has numeric Value)
  const hist = await te('/historical', { country, indicator });
  const fromHist = teTryExtract(hist);
  if (fromHist !== null) return fromHist;

  throw new Error(`${errName}: no numeric value in indicators or historical`);
}
function blsLatest(json: any, errName: string): number {
  const v = json?.Results?.series?.[0]?.data?.[0]?.value ?? json?.Results?.[0]?.series?.[0]?.data?.[0]?.value;
  return toNum(v, `${errName}: bad value`);
}

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function authorize(req: Request) {
  const required = (process.env.REFRESH_TOKEN ?? '').trim();
  if (!required) return { ok: true };
  const hdr = req.headers.get('x-refresh-token')?.trim() ?? null;
  const qs = new URL(req.url).searchParams.get('token')?.trim() ?? null;
  const ok = hdr === required || qs === required;
  if (!ok) {
    const debug = new URL(req.url).searchParams.get('debug') === '1';
    return {
      ok: false,
      resp: json(401, debug
        ? { ok:false, error:'unauthorized', debug: {
            hasRequired: Boolean(required), hasHdr: Boolean(hdr), hasQs: Boolean(qs),
            equalHdr: hdr === required, equalQs: qs === required
          }}
        : { ok:false, error:'unauthorized' }),
    };
  }
  return { ok: true };
}

async function handle(req: Request) {
  // 1) Auth
  const auth = await authorize(req);
  if (!auth.ok) return auth.resp!;

  // 2) Env sanity
  const errs: string[] = [];
  if (!process.env.FRED_KEY) errs.push('FRED_KEY missing');
  if (!process.env.BLS_KEY) errs.push('BLS_KEY missing');
  if (!process.env.TE_USER || !process.env.TE_KEY) errs.push('TE_USER/TE_KEY missing');
  if (errs.length) return json(500, { ok:false, error:'missing env vars', details: errs });

  try {
    // 3) Fetch in parallel
    const [usOas, euOas, nfci, usdIdx] = await Promise.all([
      getUsHyOAS('2021-01-01'),
      getEuHyOAS('2021-01-01'),
      getNFCI('2021-01-01'),
      getUSD('2021-01-01'),
    ]);

    const [pmiUS, pmiEA, pmiCN, pmiIN, pmiBR, pmiMX] = await Promise.all([
      tePMI('United States'),
      tePMI('Euro Area'),
      tePMI('China'),
      tePMI('India'),
      tePMI('Brazil'),
      tePMI('Mexico'),
    ]);

    const urUS = await bls(['LNS14000000'], 2021, 2026);
    const [urEA, urCN, urIN, urBR, urMX] = await Promise.all([
      teUR('Euro Area'),
      teUR('China'),
      teUR('India'),
      teUR('Brazil'),
      teUR('Mexico'),
    ]);

    // 4) Normalize “latest” values (typed helpers avoid unknown)
    const latest = {
      usHy: fredLatest(usOas, 'US HY OAS'),
      euHy: fredLatest(euOas, 'EU HY OAS'),
      nfci: fredLatest(nfci, 'NFCI'),
      usd: fredLatest(usdIdx, 'USD index'),

      pmiUS: teLatest(pmiUS, 'PMI US'),
      pmiEA: teLatest(pmiEA, 'PMI Euro Area'),
      pmiCN: teLatest(pmiCN, 'PMI China'),
      pmiIN: teLatest(pmiIN, 'PMI India'),
      pmiBR: teLatest(pmiBR, 'PMI Brazil'),
      pmiMX: teLatest(pmiMX, 'PMI Mexico'),

      urUS: blsLatest(urUS, 'US unemployment'),
      urEA: teLatest(urEA, 'UR Euro Area'),
      urCN: teLatest(urCN, 'UR China'),
      urIN: teLatest(urIN, 'UR India'),
      urBR: teLatest(urBR, 'UR Brazil'),
      urMX: teLatest(urMX, 'UR Mexico'),
    };

    const period = quarter(new Date().toISOString());
    const rows = await readRows();

    // 5) Per-region rows
    const regions: Record<string, { hy: number; fci: number; pmi: number; dxy: number; ur: number; bb: number; def: number }> = {
      USA:    { hy: latest.usHy, fci: latest.nfci, pmi: latest.pmiUS, dxy: latest.usd, ur: latest.urUS, bb: 1.06, def: 2.0 },
      Europe: { hy: latest.euHy, fci: latest.nfci, pmi: latest.pmiEA, dxy: latest.usd, ur: latest.urEA, bb: 1.04, def: 2.0 },
      China:  { hy: 380,        fci: 0.05,         pmi: latest.pmiCN, dxy: latest.usd, ur: latest.urCN, bb: 1.02, def: 3.0 },
      India:  { hy: 360,        fci: -0.25,        pmi: latest.pmiIN, dxy: latest.usd, ur: latest.urIN, bb: 1.08, def: 1.2 },
      'Latin America': { hy: 450, fci: -0.10, pmi: (latest.pmiBR + latest.pmiMX)/2, dxy: latest.usd, ur: (latest.urBR + latest.urMX)/2, bb: 1.02, def: 3.0 },
    };

    for (const [region, x] of Object.entries(regions)) {
      const riskScore = computeScore({ hyOAS: x.hy, fci: x.fci, pmi: x.pmi, dxy: x.dxy, bookBill: x.bb, ur: x.ur });
      const row = { period, region, hyOAS: x.hy, fci: x.fci, pmi: x.pmi, dxy: x.dxy, bookBill: x.bb, defaults: x.def, unemployment: x.ur, riskScore, signal: toSignal(riskScore) };
      const i = rows.findIndex(r => r.period === period && r.region === region);
      if (i >= 0) rows[i] = row; else rows.push(row);
    }

    // 6) Global (IMF-weighted)
    const get = (rname: string) => rows.find(r => r.period === period && r.region === rname)!;
    const rUS = get('USA'), rEU = get('Europe'), rCN = get('China'), rIN = get('India'), rLA = get('Latin America');

    type Key = 'hyOAS' | 'fci' | 'pmi' | 'dxy' | 'bookBill' | 'unemployment';
    const W = weights as Record<'USA' | 'Europe' | 'China' | 'India' | 'Latin America', number>;
    const wsum = (k: Key) => rUS[k]*W['USA'] + rEU[k]*W['Europe'] + rCN[k]*W['China'] + rIN[k]*W['India'] + rLA[k]*W['Latin America'];

    const g = { hyOAS: wsum('hyOAS'), fci: wsum('fci'), pmi: wsum('pmi'), dxy: rUS.dxy, bb: wsum('bookBill'), ur: wsum('unemployment') };
    const gScore = computeScore({ hyOAS: g.hyOAS, fci: g.fci, pmi: g.pmi, dxy: g.dxy, bookBill: g.bb, ur: g.ur });
    const gRow = { period, region: 'Global', hyOAS: g.hyOAS, fci: g.fci, pmi: g.pmi, dxy: g.dxy, bookBill: g.bb, defaults: 2.0, unemployment: g.ur, riskScore: gScore, signal: toSignal(gScore) };

    const gi = rows.findIndex(r => r.period === period && r.region === 'Global');
    if (gi >= 0) rows[gi] = gRow; else rows.push(gRow);

    // 7) Persist
    await writeRows(rows);

    return json(200, { ok:true, updated: rows.filter(r => r.period === period) });

  } catch (e: any) {
    return json(502, { ok:false, error:'upstream fetch failed', details: String(e?.message || e) });
  }
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }
