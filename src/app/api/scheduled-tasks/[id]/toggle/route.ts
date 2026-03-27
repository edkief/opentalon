import { NextRequest, NextResponse } from 'next/server';
import { schedulerService } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({})) as { enabled: boolean };
    
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'Missing or invalid "enabled" field' }, { status: 400 });
    }

    const all = await schedulerService.getSchedules();
    const task = all.find((s) => s.taskId === id);
    if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (body.enabled) {
      await schedulerService.enableTask(id);
    } else {
      await schedulerService.disableTask(id);
    }

    return NextResponse.json({ ok: true, enabled: body.enabled });
  } catch (err) {
    console.error('[API/scheduled-tasks/[id]/toggle] POST error:', err);
    return NextResponse.json({ error: 'Failed to toggle task' }, { status: 500 });
  }
}
