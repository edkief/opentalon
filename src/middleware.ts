import { NextResponse, type NextRequest } from 'next/server';

const PASSWORD = process.env.DASHBOARD_PASSWORD;

const PROTECTED_PREFIXES = ['/dashboard', '/api/logs', '/api/memory', '/api/soul', '/api/specialist', '/api/metrics'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (!isProtected) return NextResponse.next();

  // No password configured → open access
  if (!PASSWORD) return NextResponse.next();

  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${PASSWORD}`) return NextResponse.next();

  // Cookie-based auth for browser navigation
  const cookieToken = req.cookies.get('dashboard_token')?.value;
  if (cookieToken === PASSWORD) return NextResponse.next();

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer' },
  });
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/logs/:path*', '/api/memory/:path*', '/api/soul/:path*', '/api/specialist/:path*', '/api/metrics/:path*'],
};
