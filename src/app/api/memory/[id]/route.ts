import { NextResponse } from 'next/server';
import { qdrantClient, COLLECTION_NAME } from '@/lib/memory/client';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await qdrantClient.delete(COLLECTION_NAME, { points: [id] });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[API/memory/delete] error:', err);
    return NextResponse.json({ error: 'Failed to delete memory' }, { status: 500 });
  }
}
