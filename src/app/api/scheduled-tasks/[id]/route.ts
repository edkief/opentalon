import { NextRequest, NextResponse } from 'next/server';
import { schedulerService, TASK_QUEUE_PREFIX } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const all = await schedulerService.getSchedules();
    const task = all.find((s) => s.taskId === id);
    if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(task);
  } catch (err) {
    console.error('[API/scheduled-tasks/[id]] GET error:', err);
    return NextResponse.json({ error: 'Failed to load task' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // Fetch current schedule to merge updates against
    const all = await schedulerService.getSchedules();
    const current = all.find((s) => s.taskId === id);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json().catch(() => ({})) as {
      description?: string;
      cronExpression?: string;
      personaId?: string;
    };

    const newDescription = typeof body.description === 'string' ? body.description : current.description;
    const newCron = typeof body.cronExpression === 'string' ? body.cronExpression : current.cron;
    const newPersona = typeof body.personaId === 'string' ? body.personaId : current.personaId;

    // boss.schedule() is an upsert — re-scheduling with the same name updates data + cron
    await schedulerService.scheduleTask(id, current.chatId, newDescription, newCron, newPersona);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[API/scheduled-tasks/[id]] PATCH error:', err);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (id.startsWith(TASK_QUEUE_PREFIX)) {
      await schedulerService.unschedule(id);
    } else {
      await schedulerService.unscheduleTask(id);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[API/scheduled-tasks/[id]] DELETE error:', err);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
