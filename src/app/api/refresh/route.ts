export const runtime = 'nodejs';         // ensure Node runtime (not Edge)
export const dynamic = 'force-dynamic';  // always compute on request

import { NextResponse } from 'next/server';

// RELATIVE imports (avoid alias issues)
import { getUsHyOAS, getEuHyOAS, getNFCI, getUSD } from '../../../lib/fetchers/fred';
import { bls } from '../../../lib/fetchers/bls';
import { tePMI, teUR } from '../../../lib/fetchers/te';
import { computeScore, toSignal, quarter } from '../../../lib/normalize';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';

// ---------- helpers ----------
function last<T>(arr: T[]): T {
  if (!arr || !arr.length) throw new Error('Empty array in `last()`');
  return arr[arr.length - 1];
}

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

async function authorize(req: Request) {
  const required = (process.env.REFRESH_TOKEN ?? '').trim();
  if (!required) return { ok: true }; // open if no token set

  const hdr = req.headers.get('x-refresh-token')?.trim() ?? null;
  const qs = new URL(req.url).searchParams.get('token')?.trim() ?? null;
  const ok = hdr === required || qs === required;

  if (!ok) {
    const debug = new URL(req.url).searchParams.get('debug') === '1';
    return {
      ok: false,
      resp: json(401,
        debug
          ? { ok: false, error: 'unauthorized', debug: {
              hasRequired: Boolean(required),
              hasHdr: Boolean(hdr),
              hasQs: Boolean(qs),
              equalHdr: hdr === required,
              equalQs: qs === required,
            }}
          : { ok: false, error: 'unauthorized' }
      ),
    };
  }
  return { ok: true };
}

async function handle(req: Request) {
  // 1) Auth first
  const auth = await authorize(req);
  if (!auth.ok) return auth.resp!;

  // 2) Validate required data keys exist (clear errors if missing)
  const errs: string[] = [];
  if (!process.env.FRED_KEY) errs.push('FRED_KEY missing');
  if (!process.env.BLS_KEY) errs.push('BLS_KEY missing');
  if (!process.env.TE_USER || !process.env.TE_KEY) errs.push('TE_USER/TE_KEY missing');
  if (errs.length) return json(500, { ok: false, error: 'missing env vars', details: errs });

  // 3) Fetch external data with explicit error wrapping
  try {
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

    // normalize latest values
    const latest = {
      usHy: Number(last(usOas.observations).value),
      euHy: Number(last(euOas.observations).value),
      nfci: Number(last(nfci.observations).value),
      usd: Number(last(usdIdx.observations).value),

      pmiUS: Number(last(pmiUS).LatestValue ?? last(pmiUS).Value ?? pmiUS[0]?.Value),
      pmiEA: Number(last(pmiEA).LatestValue ?? last(pmiEA).Value ?? pmiEA[0]?.Value),
      pmiCN: Number(last(pmiCN).LatestValue ?? last(pmiCN).Value ?? pmiCN[0]?.Value),
      pmiIN: Number(last(pmiIN).LatestValue ?? last(pmiIN).Value ?? pmiIN[0]?.Value),
      pmiBR: Number(last(pmiBR).LatestValue ?? last(pmiBR).Value ?? pmiBR[0]?.Value),
      pmiMX: Number(last(pmiMX).LatestValue ?? last(pmiMX).Value ?? pmiMX[0]?.Value),

      urUS: Number(urUS.Results?.[0]?.series?.[0]?.data?.[0]?.value),
      urEA: Number(last(urEA).LatestValue ?? last(urEA).Value ?? urEA[0]?.Value),
      urCN: Number(last(urCN).LatestValue ?? last(urCN).Value ?? urCN[0]?.Value),
      urIN: Number(last(urIN).LatestValue ?? last(urIN).Value ?? urIN[0]?.Value),
      urBR: Number(last(urBR).LatestValue ?? last(urBR).Value ?? urBR[0]?.Value),
      urMX: Number(last(urMX).LatestValue ?? last(urMX).Value ?? urMX[0]?.Value),
    };

    const period = quarter(new Date().toISOString());
    const rows = await readRows();

    // 4) Per-region rows
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

    // 5) Global (IMF-weighted)
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

    // 6) Persist
    await writeRows(rows);

    return json(200, { ok: true, updated: rows.filter(r => r.period === period) });

  } catch (e: any) {
    // Surface *why* it failed instead of a blank 500 page
    return json(502, { ok: false, error: 'upstream fetch failed', details: String(e?.message || e) });
  }
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }
