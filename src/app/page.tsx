'use client';
import { useEffect, useMemo, useState } from 'react';

type Row = {
  period: string;
  hyOAS: number;
  fci: number;
  pmi: number;
  dxy: number;
  bookBill: number;
  defaults: number;
  unemployment: number;
  riskScore: number;
  signal: string;
};

const REGIONS = ["Global","USA","Europe","China","India","Latin America"] as const;
type Region = typeof REGIONS[number];

function Sparkline({ values }: { values: number[] }) {
  if (!values || values.length === 0) return null;
  const w = 120, h = 30, pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rng = Math.max(1e-6, max - min);
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - 2*pad)) / Math.max(1, values.length - 1);
    const y = h - pad - ((v - min) * (h - 2*pad)) / rng;
    return `${x},${y}`;
  }).join(' ');
  const last = values[values.length-1];
  const color = last > values[0] ? 'green' : 'red';
  return (
    <svg width={w} height={h} aria-label="sparkline">
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts} />
    </svg>
  );
}

export default function Page() {
  const [region, setRegion] = useState<Region>('Global');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/snapshot?region=${region}`)
      .then(r => r.json())
      .then(d => setRows(d.rows as Row[]))
      .finally(() => setLoading(false));
  }, [region]);

  const riskSeries = useMemo(() => rows.slice(-8).map(r => r.riskScore), [rows]);

  function exportCSV() {
    const header = ['Period','HY_OAS_bps','FCI','PMI','DXY_FX','BookToBill','Defaults_pct','Unemployment_pct','RiskScore','Signal'];
    const lines = rows.map(r => [r.period,r.hyOAS,r.fci,r.pmi,r.dxy,r.bookBill,r.defaults,r.unemployment,r.riskScore.toFixed(2),r.signal].join(','));
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `macro_${region.replace(/\s+/g,'_').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

async function refreshNow() {
  const res = await fetch('/api/refresh-now', { method: 'POST' });
  const data = await res.json();
  if (data.ok) alert('✅ Data refreshed!');
  else alert(`⚠️ Refresh failed: ${data.error ?? res.status}`);
}
  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Global & Regional Macro-Risk Dashboard</h1>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
        <label style={{ fontSize: 14 }}>Region</label>
        <select 
          value={region} 
          onChange={(e)=>setRegion(e.target.value as Region)} 
          style={{ padding:'6px 8px' }}
        >
          {REGIONS.map((r) =>( 
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        
        <button 
          onClick={exportCSV} 
          style={{ 
            marginLeft:'auto', 
            padding:'6px 10px', 
            border:'1px solid #ccc', 
            borderRadius: 8, 
            fontSize: 12,
            background: '#f6f6f6',
          }}
        >
          Export CSV
        </button>
        <button 
          onClick={refreshNow} 
          className="border rounded px-3 py-1 text-sm"
        >
          Refresh now
        </button>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        <span style={{ fontSize:13, color:'#666' }}>Composite Risk (last 8 quarters)</span>
        <Sparkline values={riskSeries} />
      </div>

      {loading ? <div>Loading…</div> : (
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign:'left' }}>
                <th style={{ padding:8 }}>Period</th>
                <th style={{ padding:8 }}>HY OAS (bps)</th>
                <th style={{ padding:8 }}>FCI / NFCI</th>
                <th style={{ padding:8 }}>PMI</th>
                <th style={{ padding:8 }}>DXY / FX</th>
                <th style={{ padding:8 }}>Book-to-Bill</th>
                <th style={{ padding:8 }}>Defaults %</th>
                <th style={{ padding:8 }}>Unemployment %</th>
                <th style={{ padding:8 }}>Risk Score (0–1)</th>
                <th style={{ padding:8 }}>Signal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r,i)=>(
                <tr key={i} style={{ borderTop:'1px solid #eee' }}>
                  <td style={{ padding:8 }}>{r.period}</td>
                  <td style={{ padding:8 }}>{r.hyOAS}</td>
                  <td style={{ padding:8 }}>{r.fci}</td>
                  <td style={{ padding:8 }}>{r.pmi}</td>
                  <td style={{ padding:8 }}>{r.dxy}</td>
                  <td style={{ padding:8 }}>{r.bookBill}</td>
                  <td style={{ padding:8 }}>{r.defaults}</td>
                  <td style={{ padding:8 }}>{r.unemployment}</td>
                  <td style={{ padding:8 }}>{r.riskScore.toFixed(2)}</td>
                  <td style={{ padding:8 }}>{r.signal}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize:12, color:'#666', marginTop:8 }}>🟢 Loose | 🟡 Neutral | 🔴 Tight. Risk Score 0 = safest, 1 = crisis-level.</p>
        </div>
      )}
    </main>
  );
}
