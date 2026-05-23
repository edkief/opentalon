import { NextRequest, NextResponse } from 'next/server';
import { listFileShares, deleteFileShare } from '@/lib/db/file-shares';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const shares = await listFileShares();
    return NextResponse.json(shares);
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
