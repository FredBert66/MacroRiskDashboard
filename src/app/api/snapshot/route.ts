import { NextResponse } from 'next/server';
import { readRows } from '@/lib/store';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const region = searchParams.get('region') ?? 'Global';
  const rows = (await readRows()).filter(r => r.region === region).sort((a,b) => a.period.localeCompare(b.period));
  return NextResponse.json({ region, rows });
}
