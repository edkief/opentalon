import { NextResponse } from 'next/server';
import { deleteRecallMemory } from '@/lib/memory/ingest';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const ok = await deleteRecallMemory(id);
  if (!ok) {
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
