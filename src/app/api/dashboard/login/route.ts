import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/config';

type AttemptRecord = {
  count: number;
  firstAttemptAt: number;
};

const attempts = new Map<string, AttemptRecord>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function getClientKey(req: NextRequest): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip')?.trim() ||
    'unknown';
  const ua = req.headers.get('user-agent') || '';
  return `${ip}|${ua.slice(0, 40)}`;
}

function getPassword(): string | undefined {
  return (
    configManager.getSecrets().dashboard?.password ??
    process.env.DASHBOARD_PASSWORD ??
    undefined
  );
}

function isRateLimited(key: string, now: number): boolean {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (now - rec.firstAttemptAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string, now: number): void {
  const rec = attempts.get(key);
  if (!rec) {
    attempts.set(key, { count: 1, firstAttemptAt: now });
  } else if (now - rec.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now });
  } else {
    rec.count += 1;
    attempts.set(key, rec);
  }
}

function resetAttempts(key: string): void {
  attempts.delete(key);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function POST(req: NextRequest) {
  const password = getPassword();
  if (!password) {
    // When no dashboard password is configured and onboarding has not yet been
    // completed (no config.yaml or no onboarding.complete flag), treat this as
    // initial setup and send the user into the onboarding flow.
    if (!configManager.isOnboarded()) {
      const res = NextResponse.json(
        { ok: true, redirectTo: '/dashboard/onboarding' },
        { status: 200 },
      );
      return res;
    }

    // If config exists but the password is missing, keep the explicit error.
    return NextResponse.json(
      { error: 'Dashboard password is not configured.' },
      { status: 400 },
    );
  }

  const key = getClientKey(req);
  const now = Date.now();

  if (isRateLimited(key, now)) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait and try again later.' },
      { status: 429 },
    );
  }

  const contentType = req.headers.get('content-type') || '';
  let token = '';
  let next = '/dashboard';

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === 'object') {
      token = typeof body.token === 'string' ? body.token : '';
      if (typeof body.next === 'string' && body.next.startsWith('/')) {
        next = body.next;
      }
    }
  } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const formData = await req.formData().catch(() => undefined);
    if (formData) {
      const rawToken = formData.get('token');
      const rawNext = formData.get('next');
      token = typeof rawToken === 'string' ? rawToken : '';
      const maybeNext = typeof rawNext === 'string' ? rawNext : undefined;
      if (maybeNext && maybeNext.startsWith('/')) {
        next = maybeNext;
      }
    }
  }

  if (!token) {
    recordFailure(key, now);
    return NextResponse.json(
      { error: 'Invalid token.' },
      { status: 401 },
    );
  }

  const ok = constantTimeEquals(token, password);
  if (!ok) {
    recordFailure(key, now);
    if (isRateLimited(key, now)) {
      return NextResponse.json(
        { error: 'Too many attempts. Please wait and try again later.' },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: 'Invalid token.' },
      { status: 401 },
    );
  }

  resetAttempts(key);

  const res = NextResponse.json(
    { ok: true, redirectTo: next },
    { status: 200 },
  );

  res.cookies.set('dashboard_token', password, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  return res;
}

