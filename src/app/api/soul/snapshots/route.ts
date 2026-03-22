import { NextRequest, NextResponse } from 'next/server';
import { soulManager } from '@/lib/soul';

export async function GET() {
  const snapshots = soulManager.listSnapshots();
  return NextResponse.json(snapshots);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { restore?: string };

  if (body.restore) {
    try {
      soulManager.restoreSnapshot(body.restore);
      return NextResponse.json({ ok: true, restored: body.restore });
    } catch {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
  }

  // Create a new snapshot of the current SOUL.md
  const filename = soulManager.createSnapshot();
  return NextResponse.json({ ok: true, filename });
}
