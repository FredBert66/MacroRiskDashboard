'use client';

import React, { useEffect, useMemo, useState } from 'react';

/** If you already have a Sparkline component, delete this and keep yours */
function Sparkline({ values = [] as number[] }) {
  const w = 160, h = 36, pad = 2;
  if (!values.length) return null;
  const vmin = Math.min(...values), vmax = Math.max(...values);
  const x = (i: number) => pad + (i * (w - pad * 2)) / (values.length - 1 || 1);
  const y = (v: number) =>
    h - pad - (v - vmin) * ((h - pad * 2) / (vmax - vmin || 1));
  const d = values.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(v)}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

type Row = {
  period: string;
  region: string;
  hyOAS: number | null;
  fci: number | null;
  pmi: number | null;
  dxy: number | null;
  bookBill: number | null;
  defaults: number | null;
  unemployment: number | null;
  riskScore: number | null;
  signal: string | null;
};

export default function Page() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState('Global');

  // Fetch last 12 rows for current region
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/snapshot?region=${encodeURIComponent(region)}&limit=12`, { cache: 'no-store' });
        const j = await r.json();
        const got = (j?.rows ?? []) as Row[];
        if (alive) setRows(got);
      } catch {
        if (alive) setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [region]);

  // Sparkline over last 8 quarters (newest last)
  const riskSeries = useMemo(() => {
    const xs = rows
      .map(r => typeof r.riskScore === 'number' ? r.riskScore : null)
      .filter((v): v is number => v !== null);
    return xs.slice(-8);
  }, [rows]);

  async function refreshNow() {
    try {
      const r = await fetch('/api/refresh-now', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        // re-fetch snapshot
        const rr = await fetch(`/api/snapshot?region=${encodeURIComponent(region)}&limit=12`, { cache: 'no-store' });
        const jj = await rr.json().catch(() => ({}));
        setRows(jj?.rows ?? []);
        alert('✅ Data refreshed!');
      } else {
        alert(`⚠️ Refresh failed: ${j?.error || r.statusText || r.status}`);
      }
    } catch (e: any) {
      alert(`⚠️ Refresh error: ${String(e?.message || e)}`);
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>
        Global &amp; Regional Macro-Risk Dashboard
      </h1>

      {/* Top controls */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ddd' }}
        >
          <option>Global</option>
          <option>USA</option>
          <option>Europe</option>
          <option>China</option>
          <option>India</option>
          <option>Latin America</option>
        </select>

        <button
          onClick={refreshNow}
          className="border rounded px-3 py-1 text-sm"
          style={{ border: '1px solid #ddd', borderRadius: 8, padding: '6px 10px', fontSize: 13 }}
        >
          Refresh now
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: '#666' }}>Composite Risk (last 8 quarters)</span>
        <Sparkline values={riskSeries} />
      </div>

      {loading ? (
        <div>Loading…</div>
      ) : (
        <>
          {/* Reference Table ABOVE the data grid */}
          <h2 style={{ fontSize: 18, marginTop: 8, marginBottom: 8 }}>Reference Ranges</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr style={{ textAlign: 'left', background: '#fafafa' }}>
                <th style={{ padding: 8 }}>Indicator</th>
                <th style={{ padding: 8 }}>Normal / Loose</th>
                <th style={{ padding: 8 }}>Caution</th>
                <th style={{ padding: 8 }}>Stress / Tight</th>
                <th style={{ padding: 8 }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ padding: 8 }}>HY OAS (bps)</td><td>&lt; 350</td><td>350–500</td><td>&gt; 500</td><td>Credit spreads</td></tr>
              <tr><td style={{ padding: 8 }}>FCI / NFCI</td><td>&lt; 0.0</td><td>0.0–0.5</td><td>&gt; 0.5</td><td>Financial conditions</td></tr>
              <tr><td style={{ padding: 8 }}>PMI</td><td>&gt; 52</td><td>48–52</td><td>&lt; 48</td><td>Economic momentum</td></tr>
              <tr><td style={{ padding: 8 }}>DXY / FX</td><td>95–105</td><td>105–110</td><td>&gt; 110</td><td>USD strength</td></tr>
              <tr><td style={{ padding: 8 }}>Book-to-Bill</td><td>&gt; 1.05</td><td>0.95–1.05</td><td>&lt; 0.95</td><td>Tech demand</td></tr>
              <tr><td style={{ padding: 8 }}>Defaults %</td><td>&lt; 2</td><td>2–4</td><td>&gt; 4</td><td>Corporate defaults</td></tr>
              <tr><td style={{ padding: 8 }}>Unemployment %</td><td>&lt; 5</td><td>5–7</td><td>&gt; 7</td><td>Labor market</td></tr>
              <tr><td style={{ padding: 8 }}>Risk Score (0–1)</td><td>&lt; 0.3</td><td>0.3–0.6</td><td>&gt; 0.6</td><td>Composite risk</td></tr>
            </tbody>
          </table>

          {/* Main data grid */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Period</th>
                  <th style={{ padding: 8 }}>HY OAS (bps)</th>
                  <th style={{ padding: 8 }}>FCI / NFCI</th>
                  <th style={{ padding: 8 }}>PMI</th>
                  <th style={{ padding: 8 }}>DXY / FX</th>
                  <th style={{ padding: 8 }}>Book-to-Bill</th>
                  <th style={{ padding: 8 }}>Defaults %</th>
                  <th style={{ padding: 8 }}>Unemployment %</th>
                  <th style={{ padding: 8 }}>Risk Score (0–1)</th>
                  <th style={{ padding: 8 }}>Signal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 8 }}>{r.period}</td>
                    <td style={{ padding: 8 }}>{r.hyOAS}</td>
                    <td style={{ padding: 8 }}>{r.fci}</td>
                    <td style={{ padding: 8 }}>{r.pmi}</td>
                    <td style={{ padding: 8 }}>{r.dxy}</td>
                    <td style={{ padding: 8 }}>{r.bookBill}</td>
                    <td style={{ padding: 8 }}>{r.defaults}</td>
                    <td style={{ padding: 8 }}>{r.unemployment}</td>
                    <td style={{ padding: 8 }}>{typeof r.riskScore === 'number' ? r.riskScore.toFixed(2) : ''}</td>
                    <td style={{ padding: 8 }}>{r.signal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
              🟢 Loose | 🟡 Neutral | 🔴 Tight. Risk Score 0 = safest, 1 = crisis-level.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
