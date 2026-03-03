import { NextRequest, NextResponse } from 'next/server';
import { schedulerService } from '@/lib/scheduler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const chatId = req.nextUrl.searchParams.get('chatId') ?? undefined;
    const tasks = await schedulerService.getSchedules(chatId);
    return NextResponse.json(tasks);
  } catch (err) {
    console.error('[API/scheduled-tasks] GET error:', err);
    return NextResponse.json({ error: 'Failed to load scheduled tasks' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      chatId?: string;
      description?: string;
      cronExpression?: string;
      personaId?: string;
    };

    if (!body.chatId || typeof body.chatId !== 'string') {
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }
    if (!body.description || typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description is required' }, { status: 400 });
    }
    if (!body.cronExpression || typeof body.cronExpression !== 'string') {
      return NextResponse.json({ error: 'cronExpression is required' }, { status: 400 });
    }

    const taskId = crypto.randomUUID();
    await schedulerService.scheduleTask(taskId, body.chatId, body.description, body.cronExpression, body.personaId);

    return NextResponse.json({ taskId, ok: true }, { status: 201 });
  } catch (err) {
    console.error('[API/scheduled-tasks] POST error:', err);
    return NextResponse.json({ error: 'Failed to create scheduled task' }, { status: 500 });
  }
}
