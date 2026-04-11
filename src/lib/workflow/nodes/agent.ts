import type { AgentNodeConfig } from '@/lib/db/schema';
import { spawnSpecialist } from '@/lib/agent/specialist';
import { getBuiltInTools } from '@/lib/tools/built-in';
import { agentRegistry } from '@/lib/soul';
import { resolveTemplate } from '@/lib/workflow/template';

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

  const tools = getBuiltInTools({ telegramChatId: chatId });

  const result = await spawnSpecialist({
    taskDescription,
    contextSnapshot,
    depth: 0,
    tools,
    agentId: config.agentId || agentRegistry.getDefaultAgent(),
    maxStepsOverride: config.maxSteps,
    timeoutMs: config.timeoutMs,
    parentChatId: chatId,
  });

  await onComplete(runNodeId, { output: result }, chatId);
}
