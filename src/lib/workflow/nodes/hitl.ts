import { db } from '@/lib/db';
import { workflowRunNodes, workflowHitlRequests, workflowRuns } from '@/lib/db/schema';
import type { HITLNodeConfig } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { emitWorkflow } from '@/lib/agent/log-bus';

export async function executeHITLNode(
  runId: string,
  runNodeId: string,
  config: HITLNodeConfig,
  chatId: string,
  onComplete: (runNodeId: string, outputData: Record<string, unknown>, chatId: string) => Promise<void>,
): Promise<void> {
  if (config.autoApprove) {
    await onComplete(runNodeId, { approved: true, autoApproved: true }, chatId);
    return;
  }

  const hitlId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + (config.ttlMs ?? 5 * 60 * 1000));

  const [runNode] = await db
    .select()
    .from(workflowRunNodes)
    .where(eq(workflowRunNodes.id, runNodeId))
    .limit(1);

  await db.insert(workflowHitlRequests).values({
    id: hitlId,
    runId,
    nodeId: runNode?.nodeId ?? runNodeId,
    prompt: config.prompt,
    chatId,
    expiresAt,
  });

  await db
    .update(workflowRunNodes)
    .set({ status: 'awaiting_hitl', hitlId, updatedAt: new Date() })
    .where(eq(workflowRunNodes.id, runNodeId));

  await db
    .update(workflowRuns)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(eq(workflowRuns.id, runId));

  const [run] = await db
    .select({ workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  emitWorkflow({
    id: crypto.randomUUID(),
    kind: 'hitl_requested',
    runId,
    workflowId: run?.workflowId ?? '',
    nodeId: runNode?.nodeId ?? runNodeId,
    nodeType: 'hitl',
    timestamp: new Date().toISOString(),
  });

  console.log(`[WorkflowEngine] HITL requested for run ${runId}, hitlId=${hitlId}`);
  // Return without calling onComplete — the resume job will do that.
}
