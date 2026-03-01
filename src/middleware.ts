import { NextResponse, type NextRequest } from 'next/server';
import { configManager } from '@/lib/config';

export const runtime = 'nodejs';

// /api/config/status is always accessible (needed for fail-safe banner)
const ALWAYS_OPEN = ['/api/config/status'];

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/api/logs',
  '/api/memory',
  '/api/soul',
  '/api/specialist',
  '/api/metrics',
  '/api/config',
];

function getPassword(): string | undefined {
  // Secrets from YAML take priority; env var is the legacy fallback
  return (
    configManager.getSecrets().dashboardPassword ??
    process.env.DASHBOARD_PASSWORD ??
    undefined
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (ALWAYS_OPEN.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!isProtected) return NextResponse.next();

  const password = getPassword();

  // No password configured → open access
  if (!password) return NextResponse.next();

  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${password}`) return NextResponse.next();

  // Cookie-based auth for browser navigation
  const cookieToken = req.cookies.get('dashboard_token')?.value;
  if (cookieToken === password) return NextResponse.next();

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer' },
  });
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/api/logs/:path*',
    '/api/memory/:path*',
    '/api/soul/:path*',
    '/api/specialist/:path*',
    '/api/metrics/:path*',
    '/api/config/:path*',
  ],
};
