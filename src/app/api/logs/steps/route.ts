import { NextRequest, NextResponse } from 'next/server';
import { getStepHistory } from '@/lib/agent/log-bus';
import { agentRegistry } from '@/lib/soul';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const chatId = searchParams.get('chatId') ?? undefined;
  const rawPersonaId = searchParams.get('agentId') ?? undefined;
  // Default agent is not stored on events (agentId is undefined for "default"),
  // so only filter by agent when it is a non-default value.
  const agentId = rawPersonaId && !agentRegistry.isDefaultAgent(rawPersonaId) ? rawPersonaId : undefined;
  const limitParam = searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 5000) : undefined;

  try {
    const events = getStepHistory(chatId, agentId, limit);
    return NextResponse.json(events);
  } catch (err) {
    console.error('[API/logs/steps] error:', err);
    return NextResponse.json({ error: 'Failed to fetch step history' }, { status: 500 });
  }
}

