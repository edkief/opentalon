import { NextResponse } from 'next/server';
import { getSpecialistHistory } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(getSpecialistHistory());
}
