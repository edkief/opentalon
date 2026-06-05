import { NextRequest, NextResponse } from 'next/server';
import { queryIndex } from '@/lib/agent/orchestration-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const search = searchParams.get('search')?.trim() || undefined;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '20', 10) || 20));

  // The DB is now the single source of truth: spawn writes a 'running' row
  // immediately, so in-flight specialists appear here without an in-memory merge.
  const { items, total } = await queryIndex({ search, page, pageSize });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return NextResponse.json({ items, total, page, pageSize, totalPages });
}
