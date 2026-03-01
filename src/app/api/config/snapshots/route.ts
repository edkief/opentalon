import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const file = (req.nextUrl.searchParams.get('file') ?? 'config') as 'config' | 'secrets';
  const snapshots = configManager.listSnapshots(file);
  return NextResponse.json(snapshots);
}

export async function POST(req: NextRequest) {
  const file = (req.nextUrl.searchParams.get('file') ?? 'config') as 'config' | 'secrets';
  const body = await req.json().catch(() => ({})) as { restore?: string };

  if (body.restore) {
    try {
      configManager.restoreSnapshot(body.restore, file);
      return NextResponse.json({ ok: true, restored: body.restore });
    } catch {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
  }

  const filename = configManager.createSnapshot(file);
  return NextResponse.json({ ok: true, filename });
}
