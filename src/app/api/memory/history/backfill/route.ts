import { NextResponse } from 'next/server';
import { schedulerService } from '@/lib/scheduler';
import { countIndexableTurns } from '@/lib/db/history-search';

export const dynamic = 'force-dynamic';

/**
 * GET → up-front cost estimate for the history backfill (#27): how many turns
 * would be gist-indexed (one cheap-model call each).
 */
export async function GET() {
  try {
    const total = await countIndexableTurns();
    return NextResponse.json({ total, estimatedLlmCalls: total });
  } catch (err) {
    console.error('[API/memory/history/backfill] estimate failed:', err);
    return NextResponse.json({ error: 'Failed to estimate backfill' }, { status: 500 });
  }
}

/**
 * POST → start (or resume) the one-time history backfill. Idempotent: already
 * indexed turns are skipped, so re-running is safe.
 */
export async function POST() {
  try {
    const result = await schedulerService.startHistoryBackfill();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[API/memory/history/backfill] start failed:', err);
    return NextResponse.json({ error: 'Failed to start backfill' }, { status: 500 });
  }
}
