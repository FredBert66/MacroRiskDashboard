import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  // Allow cron & health unauthenticated
  if (url.pathname.startsWith('/api/refresh')) return NextResponse.next();
  if (url.pathname.startsWith('/api/health')) return NextResponse.next();

  const user = process.env.DASHBOARD_USER || 'admin';
  const pass = process.env.DASHBOARD_PASS || 'changeme';
  const auth = req.headers.get('authorization');

  if (!auth || !auth.startsWith('Basic ')) {
    return new NextResponse('Auth required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' },
    });
  }
  const decoded = atob(auth.split(' ')[1]);
  const [u, p] = decoded.split(':');
  if (u !== user || p !== pass) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/api/snapshot']
};
