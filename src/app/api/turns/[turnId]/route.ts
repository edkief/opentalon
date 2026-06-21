import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { asc, eq } from 'drizzle-orm';
import { getStepHistory } from '@/lib/agent/log-bus';
import type { StepEvent } from '@/lib/agent/log-bus';
import {
  loadTurnSpecialists,
  loadTurnSpecialistsFallback,
} from '@/lib/agent/orchestration-store';

export const dynamic = 'force-dynamic';

// Grace period after the last message/step in which a specialist spawned in the
// same chat is still attributed to this turn (legacy rows without turn_id).
const FALLBACK_WINDOW_MS = 30_000;

/** Extracts background-specialist job ids from spawn_specialist tool outputs. */
function parseSpawnJobIds(steps: StepEvent[]): string[] {
  const ids: string[] = [];
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      if (tr.toolName !== 'spawn_specialist') continue;
      try {
        const parsed = JSON.parse(tr.output);
        if (parsed && typeof parsed.jobId === 'string') ids.push(parsed.jobId);
      } catch {
        // Sync spawns return plain text — no job id to extract.
      }
    }
  }
  return ids;
}

/**
 * Aggregate view of one conversation turn: the user/assistant messages, the
 * main-agent steps, and the specialist runs spawned along the way. Specialist
 * *internal* steps stay lazy via /api/logs/steps?specialistId=X.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ turnId: string }> },
) {
  const { turnId } = await params;
  if (!turnId) {
    return NextResponse.json({ error: 'turnId is required' }, { status: 400 });
  }

  try {
    const [messages, steps] = await Promise.all([
      db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.turnId, turnId))
        .orderBy(asc(schema.conversations.createdAt), asc(schema.conversations.id)),
      getStepHistory(undefined, undefined, undefined, undefined, [turnId]),
    ]);

    if (messages.length === 0 && steps.length === 0) {
      return NextResponse.json({ error: 'Turn not found' }, { status: 404 });
    }

    let specialists = await loadTurnSpecialists(turnId);

    if (specialists.length === 0) {
      // Legacy rows (pre turn_id column): attach by parsed job ids + time window.
      const chatId = messages[0]?.chatId ?? steps[0]?.sessionId;
      const timestamps = [
        ...messages.map((m) => m.createdAt.getTime()),
        ...steps.map((s) => new Date(s.timestamp).getTime()),
      ];
      if (chatId && timestamps.length > 0) {
        specialists = await loadTurnSpecialistsFallback({
          chatId,
          from: new Date(Math.min(...timestamps)),
          to: new Date(Math.max(...timestamps) + FALLBACK_WINDOW_MS),
          jobIds: parseSpawnJobIds(steps),
        });
      }
    }

    // Extract system prompt from the first main step (stored only there).
    const systemPrompt = steps
      .filter((s) => s.phase === 'main' && !s.specialistId)
      .sort((a, b) => a.stepIndex - b.stepIndex)[0]?.systemPrompt;

    return NextResponse.json({ turnId, messages, steps, specialists, systemPrompt });
  } catch (err) {
    console.error('[API/turns] error:', err);
    return NextResponse.json({ error: 'Failed to load turn' }, { status: 500 });
  }
}
