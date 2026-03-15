import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { workflowRuns, workflowRunNodes } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET /api/workflow/run/[runId] — run status + all node states
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const nodes = await db
    .select()
    .from(workflowRunNodes)
    .where(eq(workflowRunNodes.runId, runId));

  return NextResponse.json({ run, nodes });
}
