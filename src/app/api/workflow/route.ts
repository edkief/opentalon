import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { workflows } from '@/lib/db/schema';
import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { topologicalSort } from '@/lib/workflow/topology';

export const dynamic = 'force-dynamic';

// GET /api/workflow — list all workflows
export async function GET() {
  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.status, 'active'))
    .orderBy(desc(workflows.updatedAt));

  // Include drafts too
  const all = await db.select().from(workflows).orderBy(desc(workflows.updatedAt));
  return NextResponse.json(all);
}

// POST /api/workflow — create a new workflow
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description } = body as { name: string; description?: string };

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const emptyDef = {
    nodes: [
      { id: crypto.randomUUID(), type: 'input', label: 'Input', config: {} },
      { id: crypto.randomUUID(), type: 'output', label: 'Output', config: {} },
    ] as WorkflowNodeDef[],
    edges: [] as WorkflowEdgeDef[],
  };

  await db.insert(workflows).values({
    id,
    name: name.trim(),
    description: description?.trim() ?? null,
    definition: emptyDef,
    layout: {},
    status: 'draft',
  });

  const [row] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return NextResponse.json(row, { status: 201 });
}
