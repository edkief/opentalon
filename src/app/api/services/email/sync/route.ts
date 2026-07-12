import { NextResponse } from 'next/server';
import { syncEmailNow } from '@/lib/email/imap-manager';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const result = await syncEmailNow();
  if (!result.ok) return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result);
}
