import { NextRequest, NextResponse } from 'next/server';
import { workflowEngine } from '@/lib/workflow/engine';
import { db } from '@/lib/db';
import { workflowRuns, workflowRunNodes } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// POST /api/workflow/[id]/run — start a new run
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { triggerData?: Record<string, unknown>; chatId?: string };

  try {
    const runId = await workflowEngine.createRun(id, body.triggerData ?? {}, body.chatId ?? 'dashboard');
    return NextResponse.json({ runId }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// GET /api/workflow/[id]/run — list runs for a workflow
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(20);
  return NextResponse.json(runs);
}
