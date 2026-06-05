import { NextRequest, NextResponse } from 'next/server';
import { getStepHistory, getRunSteps } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const chatId = searchParams.get('chatId') ?? undefined;
  // Steps store the concrete agent name (same as the conversations table), so
  // filter by it directly. chatId alone is not a sufficient discriminant — a
  // single chat can be shared by several agents.
  const agentId = searchParams.get('agentId')?.trim() || undefined;
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 5000) : undefined;
  const specialistId = searchParams.get('specialistId') ?? undefined;

  try {
    // When a specialistId is provided, check memory first then fall back to disk
    if (specialistId) {
      const events = await getRunSteps(specialistId);
      return NextResponse.json(events);
    }

    const events = await getStepHistory(chatId, agentId, limit, specialistId);
    return NextResponse.json(events);
  } catch (err) {
    console.error('[API/logs/steps] error:', err);
    return NextResponse.json({ error: 'Failed to fetch step history' }, { status: 500 });
  }
}
