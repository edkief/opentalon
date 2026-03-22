import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { workflowRuns, workflowRunNodes, workflowHitlRequests } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET /api/workflow/run/[runId] — run status + all node states + pending HITL prompts
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [nodes, hitlRequests] = await Promise.all([
    db.select().from(workflowRunNodes).where(eq(workflowRunNodes.runId, runId)),
    db.select().from(workflowHitlRequests).where(eq(workflowHitlRequests.runId, runId)),
  ]);

  // Attach prompt to each node that has a pending HITL request
  const hitlByNodeId = Object.fromEntries(hitlRequests.map((h) => [h.nodeId, h]));
  const nodesWithHitl = nodes.map((n) => ({
    ...n,
    hitlPrompt: hitlByNodeId[n.nodeId]?.prompt ?? null,
    hitlStatus: hitlByNodeId[n.nodeId]?.status ?? null,
  }));

  return NextResponse.json({ run, nodes: nodesWithHitl });
}
