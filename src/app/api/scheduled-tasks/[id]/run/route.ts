import { NextRequest, NextResponse } from 'next/server';
import { schedulerService } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const all = await schedulerService.getSchedules();
    const task = all.find((s) => s.taskId === id);
    if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await schedulerService.executeNow(id);

    return NextResponse.json({ ok: true, message: `Task ${id} queued for immediate execution` });
  } catch (err) {
    console.error('[API/scheduled-tasks/[id]/run] POST error:', err);
    return NextResponse.json({ error: 'Failed to execute task' }, { status: 500 });
  }
}
