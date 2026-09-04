import type { AgentNodeConfig } from '@/lib/db/schema';
import { spawnSpecialist } from '@/lib/agent/specialist';
import { getBuiltInTools } from '@/lib/tools/built-in';
import { agentRegistry } from '@/lib/soul';
import { resolveTemplate } from '@/lib/workflow/template';
import { createJob, updateJobStatus } from '@/lib/db/jobs';
import { db } from '@/lib/db';
import { workflowRunNodes } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const MAX_STEPS_PREFIX = '⚠️ Reached the';

export async function executeAgentNode(
  runNodeId: string,
  config: AgentNodeConfig,
  inputData: Record<string, unknown>,
  chatId: string,
  onComplete: (runNodeId: string, outputData: Record<string, unknown>, chatId: string) => Promise<void>,
): Promise<void> {
  const taskDescription = resolveTemplate(config.taskTemplate, inputData);
  const contextSnapshot = config.contextTemplate
    ? resolveTemplate(config.contextTemplate, inputData)
    : JSON.stringify(inputData, null, 2);

  const nodeAgentId = config.agentId || agentRegistry.getDefaultAgent();
  const nodeAgentCfg = agentRegistry.getSoulManager(nodeAgentId).getConfig();
  const tools = getBuiltInTools({ chatId: chatId, agentId: nodeAgentId, toolProfile: nodeAgentCfg.toolProfile });

  // Pre-create a job record so the orchestration dashboard and resume flow can
  // reference this specialist by ID even before it completes.
  const specialistId = crypto.randomUUID();
  await createJob({ chatId, status: 'running', taskDescription }, specialistId);
  await db
    .update(workflowRunNodes)
    .set({ jobId: specialistId })
    .where(eq(workflowRunNodes.id, runNodeId));

  try {
    const result = await spawnSpecialist({
      taskDescription,
      contextSnapshot,
      depth: 0,
      tools,
      agentId: nodeAgentId,
      maxStepsOverride: config.maxSteps,
      timeoutMs: config.timeoutMs,
      specialistId,
      // A workflow run has no conversation behind it; its chatId ('system' by
      // default) is the thread its steps hang off.
      threadId: chatId,
    });

    if (result.startsWith(MAX_STEPS_PREFIX)) {
      await updateJobStatus(specialistId, 'max_steps_reached', result, undefined, config.maxSteps ?? 15);
    } else {
      await updateJobStatus(specialistId, 'completed', result);
    }

    await onComplete(runNodeId, { output: result }, chatId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJobStatus(specialistId, 'failed', undefined, message);
    throw err;
  }
}
