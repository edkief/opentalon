import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { workflows } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateWorkflow } from '@/lib/workflow/topology';

export const dynamic = 'force-dynamic';

// POST /api/workflow/import — create a workflow from an exported JSON file
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.opentalon_workflow !== '1') {
    return NextResponse.json(
      { error: 'Unrecognized file format. Expected an OpenTalon workflow export.' },
      { status: 400 },
    );
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'Workflow name is missing or invalid.' }, { status: 400 });
  }

  const definition = body.definition as { nodes?: unknown; edges?: unknown } | undefined;
  if (
    !definition ||
    !Array.isArray(definition.nodes) ||
    !Array.isArray(definition.edges)
  ) {
    return NextResponse.json(
      { error: 'Workflow definition is missing or malformed.' },
      { status: 400 },
    );
  }

  const issues = validateWorkflow(definition.nodes as never, definition.edges as never);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    return NextResponse.json(
      { error: 'Workflow graph has validation errors.', issues: errors },
      { status: 400 },
    );
  }

  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const layout = body.layout && typeof body.layout === 'object' && !Array.isArray(body.layout)
    ? (body.layout as Record<string, { x: number; y: number }>)
    : {};

  const id = crypto.randomUUID();
  await db.insert(workflows).values({
    id,
    name,
    description: description || null,
    definition: { nodes: definition.nodes, edges: definition.edges } as never,
    layout,
    status: 'draft',
  });

  const [row] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return NextResponse.json(row, { status: 201 });
}
