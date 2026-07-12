import { NextResponse } from 'next/server';
import { resyncEmailFromUid } from '@/lib/email/imap-manager';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { uid?: number };
  const uid = body.uid;
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0) {
    return NextResponse.json({ ok: false, error: 'uid must be a non-negative integer.' }, { status: 400 });
  }

  const result = await resyncEmailFromUid(uid);
  if (!result.ok) return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result);
}
