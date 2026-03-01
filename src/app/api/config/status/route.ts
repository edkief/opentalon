import { NextResponse } from 'next/server';
import { configManager } from '@/lib/config';

// No auth — always accessible so fail-safe banner can load even without credentials
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    state: configManager.state,
    error: configManager.error,
  });
}
