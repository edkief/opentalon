import { NextRequest, NextResponse } from 'next/server';
import { listFileSharesPage, deleteFileShare } from '@/lib/db/file-shares';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    );
    const { items, total } = await listFileSharesPage(pageSize, (page - 1) * pageSize);
    return NextResponse.json({ items, total, page, pageSize });
  } catch (err) {
    console.error('[API/shared-files] GET error:', err);
    return NextResponse.json({ error: 'Failed to load shared files' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json() as { id?: string };
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    await deleteFileShare(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[API/shared-files] DELETE error:', err);
    return NextResponse.json({ error: 'Failed to delete share' }, { status: 500 });
  }
}
