import { NextResponse, type NextRequest } from 'next/server';
import { configManager } from '@/lib/config';

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
  '/api/scheduled-tasks',
  '/api/agent-memory',
  '/api/services',
  '/api/tools',
  '/api/agents',
];

function getPassword(): string | undefined {
  // Secrets from YAML take priority; env var is the legacy fallback
  return (
    configManager.getSecrets().dashboard?.password ??
    process.env.DASHBOARD_PASSWORD ??
    undefined
  );
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Special-case the login page:
  // - If the user already has a valid token, redirect them to /dashboard
  // - Otherwise, allow access so they can log in
  if (pathname.startsWith('/dashboard/login')) {
    const password = getPassword();
    if (!password) {
      return NextResponse.next();
    }

    const auth = req.headers.get('authorization');
    const cookieToken = req.cookies.get('dashboard_token')?.value;

    if (auth === `Bearer ${password}` || cookieToken === password) {
      const url = req.nextUrl.clone();
      url.pathname = '/dashboard';
      url.searchParams.delete('next');
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

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

  // For HTML navigations, redirect to dashboard login with ?next=
  const accept = req.headers.get('accept') || '';
  const wantsHtml = accept.includes('text/html');
  const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';

  if (wantsHtml && isGetOrHead) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/dashboard/login';
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // For API / non-HTML requests, keep the 401 response for simplicity
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
    '/api/scheduled-tasks/:path*',
    '/api/agent-memory/:path*',
    '/api/services/:path*',
    '/api/tools/:path*',
    '/api/personas/:path*',
  ],
};
