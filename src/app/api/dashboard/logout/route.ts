import { NextRequest, NextResponse } from 'next/server';

export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ ok: true }, { status: 200 });

  // Clear the dashboard_token cookie by expiring it
  res.cookies.set('dashboard_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return res;
}

