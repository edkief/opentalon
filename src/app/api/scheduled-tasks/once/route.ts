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

