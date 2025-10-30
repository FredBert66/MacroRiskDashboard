import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getUsHyOAS, getEuHyOAS, getNFCI, getUSD } from '../../../lib/fetchers/fred';
import { bls } from '../../../lib/fetchers/bls';
import { tePMI, teUR } from '../../../lib/fetchers/te';
import { computeScore, toSignal, quarter } from '../../../lib/normalize';
import { readRows, writeRows } from '../../../lib/store';
import weights from '../../../lib/weights.json';

export async function POST() {
  try {
    const required = process.env.REFRESH_TOKEN;
    const hdrs = headers();
    const hdr = hdrs.get('x-refresh-token');
    if (required && hdr !== required) {
      return NextResponse.json({ ok:false, error:'unauthorized' }, { status: 401 });
    }

    const [usOas, euOas, nfci, usdIdx] = await Promise.all([
      getUsHyOAS('2021-01-01'), getEuHyOAS('2021-01-01'), getNFCI('2021-01-01'), getUSD('2021-01-01')
    ]);

    const [pmiUS, pmiEA, pmiCN, pmiIN, pmiBR, pmiMX] = await Promise.all([
      tePMI('United States'), tePMI('Euro Area'), tePMI('China'), tePMI('India'), tePMI('Brazil'), tePMI('Mexico')
    ]);

    const urUS = await bls(['LNS14000000'], 2021, 2026);
    const [urEA, urCN, urIN, urBR, urMX] = await Promise.all([
      teUR('Euro Area'), teUR('China'), teUR('India'), teUR('Brazil'), teUR('Mexico')
    ]);

    const last = (arr:any[]) => arr[arr.length-1];

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
      urMX: Number(last(urMX).LatestValue ?? last(urMX).Value ?? urMX[0]?.Value)
    };

    const period = quarter(new Date().toISOString());

    const regions: Record<string,{hy:number; fci:number; pmi:number; dxy:number; ur:number; bb:number; def:number}> = {
      USA:    { hy: latest.usHy, fci: latest.nfci, pmi: latest.pmiUS, dxy: latest.usd, ur: latest.urUS, bb: 1.06, def: 2.0 },
      Europe: { hy: latest.euHy, fci: latest.nfci, pmi: latest.pmiEA, dxy: latest.usd, ur: latest.urEA, bb: 1.04, def: 2.0 },
      China:  { hy: 380,        fci: 0.05,         pmi: latest.pmiCN, dxy: latest.usd, ur: latest.urCN, bb: 1.02, def: 3.0 },
      India:  { hy: 360,        fci: -0.25,        pmi: latest.pmiIN, dxy: latest.usd, ur: latest.urIN, bb: 1.08, def: 1.2 },
      'Latin America': { hy: 450, fci: -0.10, pmi: (latest.pmiBR + latest.pmiMX)/2, dxy: latest.usd, ur: (latest.urBR + latest.urMX)/2, bb: 1.02, def: 3.0 }
    };

    const rows = await readRows();

    for (const [region, x] of Object.entries(regions)) {
      const riskScore = computeScore({ hyOAS: x.hy, fci: x.fci, pmi: x.pmi, dxy: x.dxy, bookBill: x.bb, ur: x.ur });
      const signal = toSignal(riskScore);
      const row = { period, region, hyOAS: x.hy, fci: x.fci, pmi: x.pmi, dxy: x.dxy, bookBill: x.bb, defaults: x.def, unemployment: x.ur, riskScore, signal };
      const i = rows.findIndex(r => r.period === period && r.region === region);
      if (i >= 0) rows[i] = row; else rows.push(row);
    }

    // Global as IMF GDP-weighted average
    const get = (rname: string) => rows.find(r => r.period===period && r.region===rname)!;
    const rUS = get('USA'), rEU = get('Europe'), rCN = get('China'), rIN = get('India'), rLA = get('Latin America');
    const W: Record<string, number> = weights as any;
    const wsum = (k: keyof typeof rUS) => (
      (rUS[k as any] as number) * W['USA'] +
      (rEU[k as any] as number) * W['Europe'] +
      (rCN[k as any] as number) * W['China'] +
      (rIN[k as any] as number) * W['India'] +
      (rLA[k as any] as number) * W['Latin America']
    );
    const g = { hyOAS: wsum('hyOAS'), fci: wsum('fci'), pmi: wsum('pmi'), dxy: rUS.dxy, bb: wsum('bookBill'), ur: wsum('unemployment') };
    const gScore = computeScore({ hyOAS: g.hyOAS, fci: g.fci, pmi: g.pmi, dxy: g.dxy, bookBill: g.bb, ur: g.ur });
    const gRow = { period, region: 'Global', hyOAS: g.hyOAS, fci: g.fci, pmi: g.pmi, dxy: g.dxy, bookBill: g.bb, defaults: 2.0, unemployment: g.ur, riskScore: gScore, signal: toSignal(gScore) };
    const gi = rows.findIndex(r => r.period === period && r.region === 'Global');
    if (gi >= 0) rows[gi] = gRow; else rows.push(gRow);

    await writeRows(rows);
    return NextResponse.json({ ok: true, updated: rows.filter(r => r.period===period) });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e.message }, { status: 500 });
  }
}
