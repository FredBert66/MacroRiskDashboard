import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { QuarterRow } from './normalize';

const DATA = path.join(process.cwd(), 'data');
const FILE = path.join(DATA, 'snapshots.json');

function supa() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon);
}

export async function readRows(): Promise<QuarterRow[]> {
  const client = supa();
  if (client) {
    const { data, error } = await client.from('snapshots').select('*').order('period', { ascending: true });
    if (error) throw error;
    return data as QuarterRow[];
  }
  try { const raw = await fs.readFile(FILE, 'utf8'); return JSON.parse(raw); } catch { return []; }
}

export async function writeRows(rows: QuarterRow[]) {
  const client = supa();
  if (client) {
    const { error } = await client.from('snapshots').upsert(rows, { onConflict: 'period,region' });
    if (error) throw error;
    return;
  }
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(rows, null, 2), 'utf8');
}
