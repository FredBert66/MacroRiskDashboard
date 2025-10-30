import { NextResponse } from 'next/server';

// Use RELATIVE paths to avoid alias issues in Vercel
import { getUsHyOAS, getEuHyOAS, getNFCI, getUSD } from '../../../lib/fetchers/fred';
import { bls } from '../../../lib/fetchers/bls';
import { tePMI, teUR } from '../../../lib/fetchers/te';
import { computeScore, toSignal, quarter } from '../../../lib/normalize';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';

export async function POST(req: Request) {
  try {
    // --- Auth: accept header OR query param ---
    const required = (process.env.REFRESH_TOKEN ?? '').trim();
    const hdr = req.headers.get('x-refresh-token')?.trim() ?? null;
    const qsToken = new URL(req.url).searchParams.get('token')?.trim() ?? null;
    if (required && hdr !== required && qsToken !== required) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // --- Fetch external data in parallel ---
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

    // Helpers
    const last = (arr: any[]) => arr[arr.length - 1];

    // Normalize “latest” values (tolerant to TE field naming)
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

    // --- Per-region inputs (defaults/BB placeholders can be refined later) ---
    const regions: Record<
      string,
      { hy: number; fci: number; pmi: number; dxy: number; ur: number; bb: number; def: number }
    > = {
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

    // Upsert region rows for current quarter
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
        period,
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
      const i = rows.findIndex((r) => r.period === period && r.region === region);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    }

    // --- IMF GDP-weighted Global row (typed keys) ---
    const get = (rname: string) => rows.find((r) => r.period === period && r.region === rname)!;
    const rUS = get('USA');
    const rEU = get('Europe');
    const rCN = get('China');
    const rIN = get('India');
    const rLA = get('Latin America');

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
      dxy:   rUS.dxy, // stick with USD index from US
      bb:    wsum('bookBill'),
      ur:    wsum('unemployment'),
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
      period,
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

    const gi = rows.findIndex((r) => r.period === period && r.region === 'Global');
    if (gi >= 0) rows[gi] = gRow;
    else rows.push(gRow);

    await writeRows(rows);
    return NextResponse.json({ ok: true, updated: rows.filter((r) => r.period === period) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'refresh failed' }, { status: 500 });
  }
}
