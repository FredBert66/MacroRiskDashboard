export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// RELATIVE imports (avoid alias issues on Vercel)
import { getUsHyOAS, getEuHyOAS, getNFCI, getUSD } from '../../../lib/fetchers/fred';
import { bls } from '../../../lib/fetchers/bls';
import { tePMI, teUR } from '../../../lib/fetchers/te';
import { computeScore, toSignal, quarter } from '../../../lib/normalize';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';

/** ---------------- helper types & utils ---------------- **/
type FredObs = { value: string };
type FredResponse = { observations: FredObs[] };

function toNum(v: unknown, err = 'Expected number'): number {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string'
      ? Number(v.replace(/[% ,]/g, ''))
      : NaN;
  if (!Number.isFinite(n)) throw new Error(err);
  return n;
}
function last<T>(arr: T[], err = 'Empty array'): T {
  if (!arr || arr.length === 0) throw new Error(err);
  return arr[arr.length - 1];
}
function fredLatest(series: unknown, errName: string): number {
  const s = series as FredResponse;
  return toNum(
    last(s.observations, `${errName}: no observations`).value,
    `${errName}: bad value`
  );
}

/** Robust BLS parser: scan the series data for the first numeric value */
function blsLatest(json: any, errName: string): number {
  const series =
    json?.Results?.series ??
    json?.Results?.[0]?.series ??
    json?.results?.series ??
    null;
  const s0 = Array.isArray(series) ? series[0] : null;
  const data = s0?.data;
  if (!Array.isArray(data) || data.length === 0)
    throw new Error(`${errName}: empty`);

  for (const d of data) {
    const v = d?.value;
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string'
        ? Number(v.replace(/[% ,]/g, ''))
        : NaN;
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`${errName}: bad value`);
}

/** FRED fallback for US unemployment (UNRATE) */
async function fredUNRATE(start = '2021-01-01'): Promise<number> {
  const key = (process.env.FRED_KEY ?? '').trim();
  if (!key) throw new Error('FRED_KEY missing for UNRATE fallback');
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', 'UNRATE');
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('start_date', start);
  const r = await fetch(url, { next: { revalidate: 3600 } });
  if (!r.ok) throw new Error(`FRED UNRATE ${r.status}`);
  const json = (await r.json()) as FredResponse;
  return toNum(last(json.observations, 'UNRATE: no observations').value, 'UNRATE: bad value');
}

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

/** ---------------- auth ---------------- **/
async function authorize(req: Request) {
  const required   = (process.env.REFRESH_TOKEN ?? '').trim();
  const isInternal = req.headers.get('x-internal-refresh') === '1';
  if (isInternal) return { ok: true };            // <- allow proxy
  if (!required) return { ok: true };

  const hdr = req.headers.get('x-refresh-token')?.trim() ?? null;
  const qs  = new URL(req.url).searchParams.get('token')?.trim() ?? null;
  const ok  = hdr === required || qs === required;

  if (!ok) {
    const debug = new URL(req.url).searchParams.get('debug') === '1';
    return {
      ok: false,
      resp: NextResponse.json(
        debug ? {
          ok:false, error:'unauthorized',
          debug: {
            hasRequired:Boolean(required),
            hasHdr:Boolean(hdr), hasQs:Boolean(qs),
            equalHdr: hdr === required, equalQs: qs === required,
            isInternal
          }
        } : { ok:false, error:'unauthorized' },
        { status: 401 }
      )
    };
  }
  return { ok: true };
}
/** ---------------- resilient TE wrappers ---------------- **/
async function safeTE<T>(
  fn: () => Promise<T>,
  onError: (msg: string) => void
): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    onError(String(e?.message || e));
    return null;
  }
}

function getPrev(
  rows: any[],
  period: string,
  region: string,
  key: keyof any,
  fallback: number
): number {
  const prev = rows
    .filter((r) => r.region === region && r.period !== period)
    .sort((a, b) => (a.period > b.period ? 1 : -1))
    .pop();
  const v = prev?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fallback;
}

/** ---------------- handler ---------------- **/
async function handle(req: Request) {
  // 1) Auth
  const auth = await authorize(req);
  if (!auth.ok) return auth.resp!;

  // 2) Env sanity
  const errs: string[] = [];
  if (!process.env.FRED_KEY) errs.push('FRED_KEY missing');
  if (!process.env.BLS_KEY) errs.push('BLS_KEY missing');
  if (errs.length) return json(500, { ok: false, error: 'missing env vars', details: errs });

  const warnings: string[] = [];

  try {
    // 3) Fetch in parallel (FRED + BLS; TE handled safely below)
    const [usOas, euOas, nfci, usdIdx] = await Promise.all([
      getUsHyOAS('2021-01-01'),
      getEuHyOAS('2021-01-01'),
      getNFCI('2021-01-01'),
      getUSD('2021-01-01'),
    ]);

    // Try BLS first; if empty/bad, fall back to FRED UNRATE
    let urUSVal: number;
    try {
      const urUS = await bls(['LNS14000000'], 2021, 2026);
      urUSVal = blsLatest(urUS, 'US unemployment');
    } catch (e: any) {
      warnings.push(`BLS US unemployment failed: ${String(e?.message || e)} — using FRED UNRATE fallback`);
      urUSVal = await fredUNRATE('2021-01-01');
    }

    // TE calls done separately so each can fail without killing the request
    const pmiUSp = safeTE(() => tePMI('United States'), (m) =>
      warnings.push(`PMI US via TE failed: ${m}`)
    );
    const pmiEAp = safeTE(() => tePMI('Euro Area'), (m) =>
      warnings.push(`PMI EA via TE failed: ${m}`)
    );
    const pmiCNp = safeTE(() => tePMI('China'), (m) =>
      warnings.push(`PMI CN via TE failed: ${m}`)
    );
    const pmiINp = safeTE(() => tePMI('India'), (m) =>
      warnings.push(`PMI IN via TE failed: ${m}`)
    );
    const pmiBRp = safeTE(() => tePMI('Brazil'), (m) =>
      warnings.push(`PMI BR via TE failed: ${m}`)
    );
    const pmiMXp = safeTE(() => tePMI('Mexico'), (m) =>
      warnings.push(`PMI MX via TE failed: ${m}`)
    );

    const urEAp = safeTE(() => teUR('Euro Area'), (m) =>
      warnings.push(`UR EA via TE failed: ${m}`)
    );
    const urCNp = safeTE(() => teUR('China'), (m) =>
      warnings.push(`UR CN via TE failed: ${m}`)
    );
    const urINp = safeTE(() => teUR('India'), (m) =>
      warnings.push(`UR IN via TE failed: ${m}`)
    );
    const urBRp = safeTE(() => teUR('Brazil'), (m) =>
      warnings.push(`UR BR via TE failed: ${m}`)
    );
    const urMXp = safeTE(() => teUR('Mexico'), (m) =>
      warnings.push(`UR MX via TE failed: ${m}`)
    );

    // 4) Normalize latest values from FRED + US UR (with fallback)
    const latestFred = {
      usHy: fredLatest(usOas, 'US HY OAS'),
      euHy: fredLatest(euOas, 'EU HY OAS'),
      nfci: fredLatest(nfci, 'NFCI'),
      usd: fredLatest(usdIdx, 'USD index'),
      urUS: urUSVal,
    };

    const period = quarter(new Date().toISOString());
    const rows = await readRows();

    // 5) Resolve TE results with graceful fallbacks to previous data or defaults
    const [pmiUS, pmiEA, pmiCN, pmiIN, pmiBR, pmiMX] = await Promise.all([
      pmiUSp,
      pmiEAp,
      pmiCNp,
      pmiINp,
      pmiBRp,
      pmiMXp,
    ]);
    const [urEA, urCN, urIN, urBR, urMX] = await Promise.all([
      urEAp,
      urCNp,
      urINp,
      urBRp,
      urMXp,
    ]);

    const pickNum = (payload: any, errLabel: string): number | null => {
      if (!Array.isArray(payload)) return null;
      for (let i = payload.length - 1; i >= 0; i--) {
        const it = payload[i] ?? {};
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
      warnings.push(`${errLabel}: no numeric fields found in TE response`);
      return null;
    };

    const fallbackPMI = 50; // neutral PMI if nothing else available
    const fallbackUR = 6; // generic UR fallback %

    const latest = {
      ...latestFred,
      pmiUS:
        pickNum(pmiUS, 'PMI US') ??
        getPrev(rows, period, 'USA', 'pmi', fallbackPMI),
      pmiEA:
        pickNum(pmiEA, 'PMI Euro Area') ??
        getPrev(rows, period, 'Europe', 'pmi', fallbackPMI),
      pmiCN:
        pickNum(pmiCN, 'PMI China') ??
        getPrev(rows, period, 'China', 'pmi', fallbackPMI),
      pmiIN:
        pickNum(pmiIN, 'PMI India') ??
        getPrev(rows, period, 'India', 'pmi', fallbackPMI),
      pmiBR: pickNum(pmiBR, 'PMI Brazil') ?? fallbackPMI,
      pmiMX: pickNum(pmiMX, 'PMI Mexico') ?? fallbackPMI,

      urEA:
        pickNum(urEA, 'UR Euro Area') ??
        getPrev(rows, period, 'Europe', 'unemployment', fallbackUR),
      urCN:
        pickNum(urCN, 'UR China') ??
        getPrev(rows, period, 'China', 'unemployment', fallbackUR),
      urIN:
        pickNum(urIN, 'UR India') ??
        getPrev(rows, period, 'India', 'unemployment', fallbackUR),
      urBR: pickNum(urBR, 'UR Brazil') ?? fallbackUR,
      urMX: pickNum(urMX, 'UR Mexico') ?? fallbackUR,
    };

    // 6) Build/Upsert per-region rows
    const regions: Record<
      string,
      { hy: number; fci: number; pmi: number; dxy: number; ur: number; bb: number; def: number }
    > = {
      USA: {
        hy: latest.usHy,
        fci: latest.nfci,
        pmi: latest.pmiUS,
        dxy: latest.usd,
        ur: latest.urUS,
        bb: 1.06,
        def: 2.0,
      },
      Europe: {
        hy: latest.euHy,
        fci: latest.nfci,
        pmi: latest.pmiEA,
        dxy: latest.usd,
        ur: latest.urEA,
        bb: 1.04,
        def: 2.0,
      },
      China: {
        hy: 380,
        fci: 0.05,
        pmi: latest.pmiCN,
        dxy: latest.usd,
        ur: latest.urCN,
        bb: 1.02,
        def: 3.0,
      },
      India: {
        hy: 360,
        fci: -0.25,
        pmi: latest.pmiIN,
        dxy: latest.usd,
        ur: latest.urIN,
        bb: 1.08,
        def: 1.2,
      },
      'Latin America': {
        hy: 450,
        fci: -0.1,
        pmi: (latest.pmiBR + latest.pmiMX) / 2,
        dxy: latest.usd,
        ur: (latest.urBR + latest.urMX) / 2,
        bb: 1.02,
        def: 3.0,
      },
    };

    const periodStr = period;
    const rowsOut = [...rows];

    for (const [region, x] of Object.entries(regions)) {
      const riskScore = computeScore({
        hyOAS: x.hy,
        fci: x.fci,
        pmi: x.pmi,
        dxy: x.dxy,
        bookBill: x.bb,
        ur: x.ur,
      });
      const row = {
        period: periodStr,
        region,
        hyOAS: x.hy,
        fci: x.fci,
        pmi: x.pmi,
        dxy: x.dxy,
        bookBill: x.bb,
        defaults: x.def,
        unemployment: x.ur,
        riskScore,
        signal: toSignal(riskScore),
      };
      const i = rowsOut.findIndex(
        (r) => r.period === periodStr && r.region === region
      );
      if (i >= 0) rowsOut[i] = row;
      else rowsOut.push(row);
    }

    // 7) Global (IMF-weighted)
    const getRow = (rname: string) =>
      rowsOut.find((r) => r.period === periodStr && r.region === rname)!;
    const rUS = getRow('USA'),
      rEU = getRow('Europe'),
      rCN = getRow('China'),
      rIN = getRow('India'),
      rLA = getRow('Latin America');

    type Key = 'hyOAS' | 'fci' | 'pmi' | 'dxy' | 'bookBill' | 'unemployment';
    const W = weights as Record<
      'USA' | 'Europe' | 'China' | 'India' | 'Latin America',
      number
    >;
    const wsum = (k: Key) =>
      rUS[k] * W['USA'] +
      rEU[k] * W['Europe'] +
      rCN[k] * W['China'] +
      rIN[k] * W['India'] +
      rLA[k] * W['Latin America'];

    const g = {
      hyOAS: wsum('hyOAS'),
      fci: wsum('fci'),
      pmi: wsum('pmi'),
      dxy: rUS.dxy,
      bb: wsum('bookBill'),
      ur: wsum('unemployment'),
    };
    const gScore = computeScore({
      hyOAS: g.hyOAS,
      fci: g.fci,
      pmi: g.pmi,
      dxy: g.dxy,
      bookBill: g.bb,
      ur: g.ur,
    });
    const gRow = {
      period: periodStr,
      region: 'Global',
      hyOAS: g.hyOAS,
      fci: g.fci,
      pmi: g.pmi,
      dxy: g.dxy,
      bookBill: g.bb,
      defaults: 2.0,
      unemployment: g.ur,
      riskScore: gScore,
      signal: toSignal(gScore),
    };

    const gi = rowsOut.findIndex(
      (r) => r.period === periodStr && r.region === 'Global'
    );
    if (gi >= 0) rowsOut[gi] = gRow;
    else rowsOut.push(gRow);

    // 8) Persist
    await writeRows(rowsOut);

    return json(200, {
      ok: true,
      updated: rowsOut.filter((r) => r.period === periodStr),
      warnings,
    });
  } catch (e: any) {
    return json(502, {
      ok: false,
      error: 'upstream fetch failed',
      details: String(e?.message || e),
    });
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
