import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const url = req.nextUrl.pathname;

  // Always allow these (no auth)
  if (url.startsWith('/api/health')) return NextResponse.next();
  if (url.startsWith('/api/refresh')) return NextResponse.next();      // <-- allow refresh + refresh-now
  if (url.startsWith('/api/refresh-now')) return NextResponse.next();
  if (url.startsWith('/api/snapshot')) return NextResponse.next();

  // Basic auth for everything else (UI)
  const user = process.env.DASHBOARD_USER || 'admin';
  const pass = process.env.DASHBOARD_PASS || 'changeme';
  const auth = req.headers.get('authorization');

  if (!auth?.startsWith('Basic ')) {
    return new NextResponse('Auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' } });
  }
  const decoded = atob(auth.split(' ')[1]);
  const [u, p] = decoded.split(':');
  if (u !== user || p !== pass) return new NextResponse('Unauthorized', { status: 401 });

  return NextResponse.next();
}

export const config = { matcher: ['/', '/(?!api/).*'] }; // protect UI routes, not /api/*
