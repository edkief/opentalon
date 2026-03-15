import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { workflows, workflowRuns } from '@/lib/db/schema';
import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { topologicalSort } from '@/lib/workflow/topology';

export const dynamic = 'force-dynamic';

// GET /api/workflow/[id]
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [row] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(row);
}

// PUT /api/workflow/[id] — update definition + layout
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as {
    name?: string;
    description?: string;
    definition?: { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] };
    layout?: Record<string, { x: number; y: number }>;
    status?: 'draft' | 'active' | 'archived';
  };

  // Check for active runs — disallow editing while a run is in progress
  const activeRuns = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id))
    .limit(1);
  const runningRun = activeRuns.find; // we just need to check below

  const inProgressRuns = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id));
  const hasActive = inProgressRuns.some((r) => r.status === 'running' || r.status === 'paused');

  if (hasActive && body.definition) {
    return NextResponse.json(
      { error: 'Cannot update definition while a run is in progress' },
      { status: 409 },
    );
  }

  if (body.definition) {
    const { cycle } = topologicalSort(body.definition.nodes, body.definition.edges);
    if (cycle) {
      return NextResponse.json(
        { error: `Graph contains a cycle: ${cycle.join(' → ')}` },
        { status: 400 },
      );
    }
  }

  const updates: Partial<typeof workflows.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.definition !== undefined) updates.definition = body.definition;
  if (body.layout !== undefined) updates.layout = body.layout;
  if (body.status !== undefined) updates.status = body.status;

  await db.update(workflows).set(updates).where(eq(workflows.id, id));

  const [row] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return NextResponse.json(row);
}

// DELETE /api/workflow/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.update(workflows).set({ status: 'archived', updatedAt: new Date() }).where(eq(workflows.id, id));
  return NextResponse.json({ ok: true });
}
