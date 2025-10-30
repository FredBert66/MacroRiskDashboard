import { NextResponse } from 'next/server';

// RELATIVE imports (avoid alias issues on Vercel)
import { getUsHyOAS, getEuHyOAS, getNFCI, getUSD } from '../../../lib/fetchers/fred';
import { bls } from '../../../lib/fetchers/bls';
import { tePMI, teUR } from '../../../lib/fetchers/te';
import { computeScore, toSignal, quarter } from '../../../lib/normalize';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';

// ---- Auth helper (accepts header OR ?token=...) --------------------------------
async function authorize(req: Request) {
  const required = (process.env.REFRESH_TOKEN ?? '').trim();
  // If no token set in env, allow (useful for first-time seed)
  if (!required) return { ok: true };

  const hdr = req.headers.get('x-refresh-token')?.trim() ?? null;
  const qsToken = new URL(req.url).searchParams.get('token')?.trim() ?? null;
  const ok = hdr === required || qsToken === required;

  if (!ok) {
    const debugMode = new URL(req.url).searchParams.get('debug') === '1';
    return {
      ok: false,
      resp: NextResponse.json(
        debugMode
          ? {
              ok: false,
              error: 'unauthorized',
              debug: {
                hasRequired: Boolean(required),
                hasHdr: Boolean(hdr),
                hasQs: Boolean(qsToken),
                equalHdr: hdr === required,
                equalQs: qsToken === required
              }
            }
          : { ok: false, error: 'unauthorized' },
        { status: 401 }
      ),
    };
  }
  return { ok: true };
}

// ---- The core work (shared by GET and POST) ------------------------------------
async function handle(req: Request) {
  // 1) Auth
  const auth = await authorize(req);
  if (!auth.ok) return auth.resp!;

  // 2) Fetch external data in parallel
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

  const last = (arr: any[]) => arr[arr.length - 1];

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

  // 3) Per-region rows
  const regions: Record<string, { hy: number; fci: number; pmi: number; dxy: number; ur: number; bb: number; def: number }> = {
    USA:    { hy: latest.usHy, fci: latest.nfci, pmi: latest.pmiUS, dxy: latest.usd, ur: latest.urUS, bb: 1.06, def: 2.0 },
    Europe: { hy: latest.euHy, fci: latest.nfci, pmi: latest.pmiEA, dxy: latest.usd, ur: latest.urEA, bb: 1.04, def: 2.0 },
    China:  { hy: 380,        fci: 0.05,         pmi: latest.pmiCN, dxy: latest.usd, ur: latest.urCN, bb: 1.02, def: 3.0 },
    India:  { hy: 360,        fci: -0.25,        pmi: latest.pmiIN, dxy: latest.usd, ur: latest.urIN, bb: 1.08, def: 1.2 },
    'Latin America': {
      hy: 450,
      fci: -0.10,
      pmi: (latest.pmiBR + latest.pmiMX) / 2,
      dxy: latest.usd,
      ur: (latest.urBR + latest.urMX) / 2,
      bb: 1.02,
      def: 3.0,
    },
  };

  for (const [region, x] of Object.entries(regions)) {
    const riskScore = computeScore({ hyOAS: x.hy, fci: x.fci, pmi: x.pmi, dxy: x.dxy, bookBill: x.bb, ur: x.ur });
    const signal = toSignal(riskScore);
    const row = { period, region, hyOAS: x.hy, fci: x.fci, pmi: x.pmi, dxy: x.dxy, bookBill: x.bb, defaults: x.def, unemployment: x.ur, riskScore, signal };
    const i = rows.findIndex((r) => r.period === period && r.region === region);
    if (i >= 0) rows[i] = row; else rows.push(row);
  }

  // 4) IMF GDP-weighted Global
  const get = (rname: string) => rows.find((r) => r.period === period && r.region === rname)!;
  const rUS = get('USA'), rEU = get('Europe'), rCN = get('China'), rIN = get('India'), rLA = get('Latin America');

  type NumericKey = 'hyOAS' | 'fci' | 'pmi' | 'dxy' | 'bookBill' | 'unemployment';
  const W = weights as Record<'USA' | 'Europe' | 'China' | 'India' | 'Latin America', number>;

  const wsum = (k: NumericKey) =>
    rUS[k] * W['USA'] +
    rEU[k] * W['Europe'] +
    rCN[k] * W['China'] +
    rIN[k] * W['India'] +
    rLA[k] * W['Latin America'];

  const g = {
    hyOAS: wsum('hyOAS'),
    fci:   wsum('fci'),
    pmi:   wsum('pmi'),
    dxy:   rUS.dxy,
    bb:    wsum('bookBill'),
    ur:    wsum('unemployment'),
  };

  const gScore = computeScore({ hyOAS: g.hyOAS, fci: g.fci, pmi: g.pmi, dxy: g.dxy, bookBill: g.bb, ur: g.ur });
  const gRow = { period, region: 'Global', hyOAS: g.hyOAS, fci: g.fci, pmi: g.pmi, dxy: g.dxy, bookBill: g.bb, defaults: 2.0, unemployment: g.ur, riskScore: gScore, signal: toSignal(gScore) };

  const gi = rows.findIndex((r) => r.period === period && r.region === 'Global');
  if (gi >= 0) rows[gi] = gRow; else rows.push(gRow);

  // 5) Persist
  await writeRows(rows);

  return NextResponse.json({ ok: true, updated: rows.filter((r) => r.period === period) });
}

// Export both GET and POST so you can trigger it from the browser or curl
export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
