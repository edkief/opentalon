import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { emitSpecialist, emitStep } from './log-bus';
import { configManager } from '../config';
import { memoryManager } from './memory-manager';
import { schedulerService } from '../scheduler';
import { getSkillsSummary } from '../tools';
import { agentRegistry } from '../soul';
import { resolveModelList } from './model-resolver';
import { createJob, updateJobStatus } from '../db/jobs';

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
  modelUsed?: string;
}

async function executeSpecialist(
  taskDescription: string,
  contextSnapshot: string,
  tools?: ToolSet,
  agentId: string = 'default',
  maxStepsOverride?: number,
  specialistId?: string,
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
  const maxTokens = configManager.get().llm?.maxTokens ?? undefined;

  let lastError = '';
  for (const resolved of models) {
    try {
      let stepIndex = 0;
      const result = await generateText({
        model: resolved.model,
        system,
        messages: [{ role: 'user', content: taskDescription }],
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(toolKeys.length > 0
          ? { tools, toolChoice: 'auto', stopWhen: stepCountIs(maxSteps) }
          : {}),
        onStepFinish: (step: any) => {
          if (specialistId) {
            emitStep({
              id: crypto.randomUUID(),
              sessionId: specialistId,
              timestamp: new Date().toISOString(),
              stepIndex: ++stepIndex,
              finishReason: step.finishReason,
              text: step.text || undefined,
              toolCalls: step.toolCalls?.map((tc: any) => ({ toolName: tc.toolName, input: tc.input ?? tc.args })),
              toolResults: step.toolResults?.map((tr: any) => ({
                toolName: tr.toolName,
                output: String(tr.output ?? tr.result ?? '').slice(0, 10_000),
              })),
              specialistId,
            });
          }
        },
      });

      // Detect max-steps cutoff: last step ended with tool-calls
      // This can happen with OR without final text - the model may have generated
      // text like "let me continue working on this..." but hit the step limit
      const lastStep = result.steps[result.steps.length - 1];
      const hitMaxSteps = lastStep?.finishReason === 'tool-calls';

      if (result.text && !hitMaxSteps) {
        return { text: result.text, hitMaxSteps: false, modelUsed: resolved.modelString };
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
        modelUsed: resolved.modelString,
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
  parentSpecialistId?: string; // ID of the specialist that spawned this one (depth=2 case)
}

/**
 * Spawns a stateless, constrained sub-agent to handle a focused task.
 * Includes Core Memory (MEMORY.md) for operational context; no RAG. Result is returned as a plain string.
 */
export async function spawnSpecialist(options: SpecialistOptions & { parentSessionId?: string }): Promise<string> {
  const { taskDescription, contextSnapshot, depth, tools, timeoutMs = 60_000, parentSessionId = 'unknown', agentId = 'default', maxStepsOverride, spawningAgentId, parentSpecialistId } = options;

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
    parentSpecialistId,
    agentId: agentId === 'default' ? undefined : agentId,
  });

  const timeout = new Promise<SpecialistResult>((_, reject) =>
    setTimeout(() => reject(new Error(`Specialist timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );

  try {
    const result = await Promise.race([
      executeSpecialist(taskDescription, contextSnapshot, tools, agentId, maxStepsOverride, specialistId),
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
        result: result.text.slice(0, 2_000),
        durationMs: Date.now() - startMs,
        maxStepsUsed: result.maxStepsUsed,
        canResume: true,
        timestamp: new Date().toISOString(),
        parentSpecialistId,
        agentId: agentId === 'default' ? undefined : agentId,
        modelUsed: result.modelUsed,
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
      result: result.text.slice(0, 2_000),
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
      parentSpecialistId,
      agentId: agentId === 'default' ? undefined : agentId,
      modelUsed: result.modelUsed,
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
      parentSpecialistId,
      agentId: agentId === 'default' ? undefined : agentId,
    });

    return `Specialist failed: ${message}`;
  }
}

/**
 * Tracks in-flight inline specialists (spawned from a background context).
 * Keyed by specialistId; each entry holds the settled result promise.
 */
interface InFlightEntry {
  promise: Promise<string>;
  taskDescription: string;
  startMs: number;
}

/**
 * Creates the spawn_specialist and (when inside a background task) await_specialists tools.
 *
 * When currentSpecialistId is set (i.e. the caller is itself a background specialist), the
 * background:true path runs specialists **inline** rather than dispatching to pg-boss, so the
 * orchestrator can later call await_specialists to block until all of them finish and read
 * their results. This avoids the chat-queue deadlock that would occur if child specialists
 * were enqueued behind the parent on the same chatId.
 *
 * When currentSpecialistId is NOT set (user-facing depth-0 agent), the original pg-boss
 * dispatch path is preserved unchanged.
 */
export function createSpecialistTools(
  currentDepth: number,
  availableTools: ToolSet,
  parentSessionId?: string,
  spawningAgentId?: string,
  currentSpecialistId?: string,
): ToolSet {
  const isInsideBackgroundTask = !!currentSpecialistId;

  // Shared map for inline specialists spawned within this execution context.
  // Only populated when isInsideBackgroundTask is true.
  const inFlight = new Map<string, InFlightEntry>();

  // Timeout for inline specialists (longer since parent is already in background)
  const inlineTimeoutMs = (configManager.get().llm as any)?.specialistTimeoutMs ?? 300_000; // 5 min default

  const spawn_specialist = tool({
    description:
      'Delegate a focused analysis or data-processing task to a specialist sub-agent. ' +
      'Use when you need deep analysis, log parsing, or multi-step reasoning on a specific topic ' +
      'and want to keep the main conversation clean. The specialist works independently and returns a summary. ' +
      (isInsideBackgroundTask
        ? 'Set background: true to start the specialist without waiting for it — then call await_specialists with the returned job IDs to collect all results at once, enabling parallel execution.'
        : 'Set background: true to run asynchronously — you get a job ID immediately and the result is delivered ' +
          'in a follow-up turn, allowing you to run multiple specialists in parallel.'),
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
          isInsideBackgroundTask
            ? 'If true, start the specialist without waiting. Call await_specialists to collect results. ' +
              'Spawn multiple specialists with background:true then await them all at once for parallel execution.'
            : 'If true, run the specialist asynchronously. Returns a job ID immediately so you can ' +
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
        // Synchronous path — blocks until the specialist finishes.
        // Use a longer timeout when we're already inside a background task.
        const timeoutMs = isInsideBackgroundTask ? inlineTimeoutMs : 60_000;
        return spawnSpecialist({
          taskDescription: input.task_description,
          contextSnapshot: input.context_snapshot,
          depth: currentDepth + 1,
          tools: availableTools,
          timeoutMs,
          parentSessionId,
          agentId: input.agent_id,
          spawningAgentId,
          parentSpecialistId: currentSpecialistId,
        });
      }

      if (isInsideBackgroundTask) {
        // ── Inline fork path (background task spawning a child specialist) ────────
        // Execute the specialist as a Promise without awaiting, store it in the
        // inFlight map, and return the job ID immediately. The orchestrator can
        // later call await_specialists to resolve all in-flight promises at once.
        // This avoids the chat-queue deadlock: children never call enqueueForChat.

        const chatId = parentSessionId ?? 'unknown';
        const specialistId = crypto.randomUUID();
        const startMs = Date.now();

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
          parentSpecialistId: currentSpecialistId,
          agentId: input.agent_id && input.agent_id !== 'default' ? input.agent_id : undefined,
        });

        // Create job record so the dashboard and resume flow work.
        await createJob({ chatId, status: 'running', taskDescription: enrichedDescription }, specialistId);

        // Build the inline execution promise. We don't await it here.
        const agentId = input.agent_id ?? 'default';
        const promise: Promise<string> = (async () => {
          try {
            // Depth-limit check (same logic as spawnSpecialist)
            const depth = currentDepth + 1;
            if (depth > 1) {
              if (depth > 2) throw new DepthLimitError();
              if (!spawningAgentId) throw new DepthLimitError();
              const spawningConfig = agentRegistry.getSoulManager(spawningAgentId).getConfig();
              const allowed =
                spawningConfig.canSpawnSubAgents === true &&
                Array.isArray(spawningConfig.allowedSubAgents) &&
                spawningConfig.allowedSubAgents.includes(agentId);
              if (!allowed) throw new DepthLimitError();
            }

            const timeoutPromise = new Promise<SpecialistResult>((_, reject) =>
              setTimeout(() => reject(new Error(`Specialist timed out after ${inlineTimeoutMs / 1000}s`)), inlineTimeoutMs)
            );

            const result = await Promise.race([
              executeSpecialist(enrichedDescription, '', availableTools, agentId, undefined, specialistId),
              timeoutPromise,
            ]);

            const text = result.hitMaxSteps
              ? `⚠️ Reached the ${result.maxStepsUsed ?? 15}-step limit mid-task.\n\n${result.text}`
              : result.text;

            const kind = result.hitMaxSteps ? 'max_steps' : 'complete';
            emitSpecialist({
              id: crypto.randomUUID(),
              kind,
              specialistId,
              parentSessionId: chatId,
              taskDescription: input.task_description,
              result: text.slice(0, 2_000),
              durationMs: Date.now() - startMs,
              maxStepsUsed: result.hitMaxSteps ? result.maxStepsUsed : undefined,
              canResume: result.hitMaxSteps,
              timestamp: new Date().toISOString(),
              parentSpecialistId: currentSpecialistId,
              agentId: agentId === 'default' ? undefined : agentId,
              modelUsed: result.modelUsed,
            });

            const status = result.hitMaxSteps ? 'max_steps_reached' : 'completed';
            await updateJobStatus(specialistId, status, text.slice(0, 5_000), undefined, result.hitMaxSteps ? result.maxStepsUsed : undefined);

            return text;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitSpecialist({
              id: crypto.randomUUID(),
              kind: 'error',
              specialistId,
              parentSessionId: chatId,
              taskDescription: input.task_description,
              result: message,
              durationMs: Date.now() - startMs,
              timestamp: new Date().toISOString(),
              parentSpecialistId: currentSpecialistId,
              agentId: agentId === 'default' ? undefined : agentId,
            });
            await updateJobStatus(specialistId, 'failed', undefined, message);
            return `Specialist failed: ${message}`;
          }
        })();

        inFlight.set(specialistId, { promise, taskDescription: input.task_description, startMs });

        return JSON.stringify({
          jobId: specialistId,
          status: 'started',
          message: `Specialist is running (ID: ${specialistId}). Call await_specialists with this ID to wait for the result.`,
        });
      }

      // ── pg-boss dispatch path (user-facing depth-0 agent) ─────────────────────
      // Unchanged from original: dispatch to pg-boss and return immediately.
      const chatId = parentSessionId ?? 'unknown';
      const specialistId = crypto.randomUUID();

      const enrichedDescription = input.context_snapshot
        ? `${input.task_description}\n\nContext:\n${input.context_snapshot}`
        : input.task_description;

      emitSpecialist({
        id: crypto.randomUUID(),
        kind: 'spawn',
        specialistId,
        parentSessionId: parentSessionId ?? 'unknown',
        taskDescription: input.task_description,
        contextSnapshot: input.context_snapshot,
        timestamp: new Date().toISOString(),
        background: true,
        parentSpecialistId: currentSpecialistId,
        agentId: input.agent_id && input.agent_id !== 'default' ? input.agent_id : undefined,
      });

      await createJob({
        chatId,
        status: 'pending',
        taskDescription: enrichedDescription,
      }, specialistId);

      await schedulerService.scheduleOnce(specialistId, chatId, enrichedDescription, 0, { specialistId, agentId: input.agent_id, spawningAgentId, parentSpecialistId: currentSpecialistId });

      return JSON.stringify({
        jobId: specialistId,
        status: 'started',
        message: `Specialist is running in the background (ID: ${specialistId}). I'll deliver the results when it completes.`,
      });
    },
  } as any);

  if (!isInsideBackgroundTask) {
    // User-facing agents don't get await_specialists — they use the pg-boss
    // fire-and-forget pattern where results are delivered via Telegram message.
    return { spawn_specialist };
  }

  const await_specialists = tool({
    description:
      'Wait for one or more background specialists (started with spawn_specialist background:true) to finish ' +
      'and return their results. Call this after spawning all your parallel specialists to collect results before ' +
      'proceeding. Results are returned as a JSON array with id, status, and result for each specialist.',
    inputSchema: z.object({
      job_ids: z
        .array(z.string())
        .describe('List of specialist job IDs (returned by spawn_specialist) to wait for'),
    }) as any,
    execute: async (input: { job_ids: string[] }) => {
      const results = await Promise.allSettled(
        input.job_ids.map(async (id) => {
          const entry = inFlight.get(id);
          if (entry) {
            const result = await entry.promise;
            inFlight.delete(id);
            return { id, status: 'completed', result };
          }
          // Fallback: specialist may have been dispatched via pg-boss (edge case)
          // or already resolved — check the DB.
          const { getJobById } = await import('../db/jobs');
          const job = await getJobById(id);
          if (!job) return { id, status: 'not_found', result: '' };
          return { id, status: job.status, result: job.result ?? '' };
        })
      );

      const output = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        return { id: input.job_ids[i], status: 'error', result: r.reason?.message ?? String(r.reason) };
      });

      return JSON.stringify(output, null, 2);
    },
  } as any);

  return { spawn_specialist, await_specialists };
}

/**
 * @deprecated Use createSpecialistTools() instead.
 * Kept for backward compatibility — returns only the spawn_specialist tool.
 */
export function createSpawnSpecialistTool(
  currentDepth: number,
  availableTools: ToolSet,
  parentSessionId?: string,
  spawningAgentId?: string,
  currentSpecialistId?: string,
) {
  const tools = createSpecialistTools(currentDepth, availableTools, parentSessionId, spawningAgentId, currentSpecialistId);
  return tools.spawn_specialist;
}
