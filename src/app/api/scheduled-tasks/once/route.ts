import { NextRequest, NextResponse } from 'next/server';
import { schedulerService } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const chatId = req.nextUrl.searchParams.get('chatId') ?? undefined;
    const tasks = await schedulerService.getOneOffTasks(chatId);
    return NextResponse.json(tasks);
  } catch (err) {
    console.error('[API/scheduled-tasks/once] GET error:', err);
    return NextResponse.json(
      { error: 'Failed to load one-off tasks' },
      { status: 500 },
    );
  }
}

const CANCEL_STATUS = {
  cancelled: 200,
  already_running: 409,
  already_finished: 409,
  not_cancellable: 409,
  not_found: 404,
} as const;

export async function DELETE(req: NextRequest) {
  try {
    const taskId = req.nextUrl.searchParams.get('taskId');
    if (!taskId) return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    const result = await schedulerService.cancelOneOffTask(taskId);
    return NextResponse.json(result, { status: CANCEL_STATUS[result.state] });
  } catch (err) {
    console.error('[API/scheduled-tasks/once] DELETE error:', err);
    return NextResponse.json(
      { error: 'Failed to cancel one-off task' },
      { status: 500 },
    );
  }
}
