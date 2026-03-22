import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const snapshots = agentRegistry.getSoulManager(id).listSnapshots();
  return NextResponse.json(snapshots);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const body = await req.json().catch(() => ({})) as { restore?: string };

  if (body.restore) {
    try {
      agentRegistry.getSoulManager(id).restoreSnapshot(body.restore);
      return NextResponse.json({ ok: true, restored: body.restore });
    } catch {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
  }

  const filename = agentRegistry.getSoulManager(id).createSnapshot();
  return NextResponse.json({ ok: true, filename });
}
