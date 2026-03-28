import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { emitSpecialist } from './log-bus';
import { memoryManager } from './memory-manager';
import { schedulerService } from '../scheduler';
import { getSkillsSummary } from '../tools';
import { agentRegistry } from '../soul';
import { resolveModelList } from './model-resolver';
import { createJob } from '../db/jobs';

export class DepthLimitError extends Error {
  constructor() {
    super('Specialists cannot spawn further specialists (max depth reached)');
    this.name = 'DepthLimitError';
  }
}

export interface SpecialistResult {
  text: string;
  hitMaxSteps: boolean;
  maxStepsUsed?: number;
}

async function executeSpecialist(
  taskDescription: string,
  contextSnapshot: string,
  tools?: ToolSet,
  agentId: string = 'default',
  maxStepsOverride?: number,
): Promise<SpecialistResult> {
  const sm = agentRegistry.getSoulManager(agentId);
  const agentConfig = sm.getConfig();
  const models = resolveModelList(agentConfig.model, agentConfig.fallbacks);

  const skillsSummary = await getSkillsSummary();
  const agentSoul = sm.getContent();
  const memoryContent = memoryManager.getContent();

  const system = [
    '## Role',
    'You are a focused sub-agent (specialist). Complete ONLY the task assigned to you.',
    'Do not ask clarifying questions. Return your complete findings as plain text.',
    'If you need to reference files, include their full path and description in your response.',
    'You have skills at your disposal, use them if they help with your task.',
    ...(agentSoul ? ['', '## Agent Soul', agentSoul] : []),
    ...(memoryContent ? ['', '## Core Memory (operational context)', memoryContent] : []),
    '',
    '## Context from Supervisor',
    contextSnapshot || '(no additional context provided)',
    ...(skillsSummary ? ['', '## Available Skills', skillsSummary] : []),
    '',
    '## Your Task',
    taskDescription,
  ].join('\n');

  const toolKeys = tools ? Object.keys(tools) : [];
  const maxSteps = maxStepsOverride ?? 15;

  let lastError = '';
  for (const resolved of models) {
    try {
      const result = await generateText({
        model: resolved.model,
        system,
        messages: [{ role: 'user', content: taskDescription }],
        ...(toolKeys.length > 0
          ? { tools, toolChoice: 'auto', stopWhen: stepCountIs(maxSteps) }
          : {}),
      });

      // Detect max-steps cutoff: last step ended with tool-calls
      // This can happen with OR without final text - the model may have generated
      // text like "let me continue working on this..." but hit the step limit
      const lastStep = result.steps[result.steps.length - 1];
      const hitMaxSteps = lastStep?.finishReason === 'tool-calls';

      if (result.text && !hitMaxSteps) {
        return { text: result.text, hitMaxSteps: false };
      }

      // If we hit max steps OR have no text, collect any text produced across all steps
      const stepTexts = result.steps
        .map((s) => s.text)
        .filter(Boolean)
        .join('\n\n');

      return {
        text: stepTexts || result.text || '(specialist returned no output)',
        hitMaxSteps,
        maxStepsUsed: hitMaxSteps ? maxSteps : undefined,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[Specialist] Model ${resolved.modelString} failed:`, lastError);
    }
  }

  throw new Error(`All specialist models failed. Last error: ${lastError}`);
}

export interface SpecialistOptions {
  taskDescription: string;
  contextSnapshot: string;
  depth: number;
  tools?: ToolSet;
  timeoutMs?: number;
  agentId?: string;
  maxStepsOverride?: number;
  spawningAgentId?: string; // ID of the agent that called spawn_specialist (for permission checks)
}

/**
 * Spawns a stateless, constrained sub-agent to handle a focused task.
 * Includes Core Memory (MEMORY.md) for operational context; no RAG. Result is returned as a plain string.
 */
export async function spawnSpecialist(options: SpecialistOptions & { parentSessionId?: string }): Promise<string> {
  const { taskDescription, contextSnapshot, depth, tools, timeoutMs = 60_000, parentSessionId = 'unknown', agentId = 'default', maxStepsOverride, spawningAgentId } = options;

  if (depth > 1) {
    // Absolute hard cap — sub-agents (depth=2) can never spawn further
    if (depth > 2) throw new DepthLimitError();
    // At depth 2, require the spawning agent to have explicitly opted in
    if (!spawningAgentId) throw new DepthLimitError();
    const spawningConfig = agentRegistry.getSoulManager(spawningAgentId).getConfig();
    const targetId = agentId;
    const allowed =
      spawningConfig.canSpawnSubAgents === true &&
      Array.isArray(spawningConfig.allowedSubAgents) &&
      spawningConfig.allowedSubAgents.includes(targetId);
    if (!allowed) throw new DepthLimitError();
  }

  const specialistId = crypto.randomUUID();
  const startMs = Date.now();

  emitSpecialist({
    id: crypto.randomUUID(),
    kind: 'spawn',
    specialistId,
    parentSessionId,
    taskDescription,
    contextSnapshot,
    timestamp: new Date().toISOString(),
  });

  const timeout = new Promise<SpecialistResult>((_, reject) =>
    setTimeout(() => reject(new Error(`Specialist timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );

  try {
    const result = await Promise.race([
      executeSpecialist(taskDescription, contextSnapshot, tools, agentId, maxStepsOverride),
      timeout,
    ]);

    if (result.hitMaxSteps) {
      // Emit max_steps event with resume capability
      emitSpecialist({
        id: crypto.randomUUID(),
        kind: 'max_steps',
        specialistId,
        parentSessionId,
        taskDescription,
        result: result.text.slice(0, 500),
        durationMs: Date.now() - startMs,
        maxStepsUsed: result.maxStepsUsed,
        canResume: true,
        timestamp: new Date().toISOString(),
      });

      // Return text indicating max steps was hit, but include the partial results
      return `⚠️ Reached the ${result.maxStepsUsed ?? 15}-step limit mid-task.\n\n${result.text}\n\nTo resume this task, use /resume ${specialistId} [additional_steps]`;
    }

    emitSpecialist({
      id: crypto.randomUUID(),
      kind: 'complete',
      specialistId,
      parentSessionId,
      taskDescription,
      result: result.text.slice(0, 500),
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    });

    return result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Specialist] Task failed:', message);

    emitSpecialist({
      id: crypto.randomUUID(),
      kind: 'error',
      specialistId,
      parentSessionId,
      taskDescription,
      result: message,
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    });

    return `Specialist failed: ${message}`;
  }
}

/**
 * Returns an AI SDK tool that the Supervisor can call to delegate tasks.
 * Depth is captured in closure so specialists cannot recursively spawn specialists.
 * Background mode dispatches to pg-boss (same queue as scheduled tasks) so there
 * is no in-process timeout and results survive process restarts.
 */
export function createSpawnSpecialistTool(
  currentDepth: number,
  availableTools: ToolSet,
  parentSessionId?: string,
  spawningAgentId?: string,
) {
  return tool({
    description:
      'Delegate a focused analysis or data-processing task to a specialist sub-agent. ' +
      'Use when you need deep analysis, log parsing, or multi-step reasoning on a specific topic ' +
      'and want to keep the main conversation clean. The specialist works independently and returns a summary. ' +
      'Set background: true to run asynchronously — you get a job ID immediately and the result is delivered ' +
      'in a follow-up turn, allowing you to run multiple specialists in parallel.',
    inputSchema: z.object({
      task_description: z
        .string()
        .describe('Clear, self-contained description of what the specialist must do'),
      context_snapshot: z
        .string()
        .describe('Relevant context the specialist needs (facts, data, constraints). Be concise.'),
      background: z
        .boolean()
        .optional()
        .describe(
          'If true, run the specialist asynchronously. Returns a job ID immediately so you can ' +
          'respond to the user right away. Results arrive in a follow-up turn. ' +
          'Use for long tasks or to run multiple specialists in parallel.',
        ),
      agent_id: z
        .string()
        .optional()
        .describe('Agent to use for this specialist. Defaults to the current active agent.'),
    }) as any,
    execute: async (input: { task_description: string; context_snapshot: string; background?: boolean; agent_id?: string }) => {
      if (!input.background) {
        // Synchronous path — blocks until the specialist finishes
        return spawnSpecialist({
          taskDescription: input.task_description,
          contextSnapshot: input.context_snapshot,
          depth: currentDepth + 1,
          tools: availableTools,
          parentSessionId,
          agentId: input.agent_id,
          spawningAgentId,
        });
      }

      // Asynchronous path — dispatch via pg-boss (same queue as scheduled tasks).
      // This avoids the in-process 60 s timeout and keeps a single worker code path.
      const chatId = parentSessionId ?? 'unknown';
      const specialistId = crypto.randomUUID();

      // Embed context into the description so the handler doesn't need a separate field.
      const enrichedDescription = input.context_snapshot
        ? `${input.task_description}\n\nContext:\n${input.context_snapshot}`
        : input.task_description;

      // Emit spawn event so the Orchestration dashboard shows the task immediately.
      emitSpecialist({
        id: crypto.randomUUID(),
        kind: 'spawn',
        specialistId,
        parentSessionId: parentSessionId ?? 'unknown',
        taskDescription: input.task_description,
        contextSnapshot: input.context_snapshot,
        timestamp: new Date().toISOString(),
        background: true,
      });

      // Create job record in database so it can be resumed later
      await createJob({
        chatId,
        status: 'pending',
        taskDescription: enrichedDescription,
      }, specialistId);

      await schedulerService.scheduleOnce(specialistId, chatId, enrichedDescription, 0, { specialistId, agentId: input.agent_id, spawningAgentId });

      return JSON.stringify({
        jobId: specialistId,
        status: 'started',
        message: `Specialist is running in the background (ID: ${specialistId}). I'll deliver the results when it completes.`,
      });
    },
  } as any);
}
