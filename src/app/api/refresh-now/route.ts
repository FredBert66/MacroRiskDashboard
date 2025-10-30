import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

// import your existing POST handler (we’ll reuse it)
import { POST as refreshPOST } from '../../../refresh/route';

// Proxy call so the token never leaves the server
export async function POST() {
  // Inject the token into the header context by temporarily relaxing /api/refresh check:
  // Update /api/refresh to accept either the header OR a query param (?token=...)
  const token = process.env.REFRESH_TOKEN ?? '';
  const res = await fetch(new URL('/api/refresh?token=' + encodeURIComponent(token), 'http://localhost').toString(), {
    method: 'POST',
    // Headers won't matter when we pass token via query param
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
