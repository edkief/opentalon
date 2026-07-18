import { generateText, stepCountIs, tool, APICallError } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import type { StepView, GenerationResult } from './types';
import { emitSpecialist, emitStep, mapStepToolResults } from './log-bus';
import { extractUsage } from './usage';
import { runStreamedGeneration } from './streamed-step';
import { wrapModelWithToolCompression } from './middleware';
import { configManager } from '../config';
import { cancellationRegistry } from './cancellation';
import { memoryManager } from './memory-manager';
import { schedulerService } from '../scheduler';
import { getSkillsSummary } from '../tools';
import { agentRegistry } from '../soul';
import { resolveModelList, parseModelString } from './model-resolver';
import { createJob, updateJobStatus } from '../db/jobs';
import { todoManager, TODO_TOOL_NAMES } from './todo-manager';
import { getTodoTools } from '../tools/todos';

/**
 * Same classification as LLMExecutor's classifyError: skip remaining
 * same-provider models after a non-retryable (400/401/403) failure instead
 * of paying full-context cost N more times for a guaranteed identical error.
 */
function isNonRetryableSameProvider(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  const status = err.statusCode;
  return err.isRetryable === false && (status === 400 || status === 401 || status === 403);
}

export interface SpecialistResult {
  text: string;
  hitMaxSteps: boolean;
  maxStepsUsed?: number;
  modelUsed?: string;
}

/**
 * Core tools every specialist keeps regardless of the requested subset, so a
 * task-scoped selection can never leave a specialist unable to read/write files
 * or run a command. (todo tools are re-added separately, scoped to the
 * specialist's own id.)
 */
export const SPECIALIST_CORE_TOOLS = ['read_file', 'write_file', 'str_replace_based_edit', 'run_command'];

/**
 * Restrict a tool set to a task-scoped subset (#19 part 3): stateless
 * specialists should not inherit all ~45 tools when the task only needs a few.
 * Keeps the requested names plus SPECIALIST_CORE_TOOLS. Unknown names are
 * ignored; an empty/over-restrictive result falls back to the full set rather
 * than handing back a specialist with no tools.
 */
export function scopeToolsByNames(all: ToolSet, requested: string[] | undefined): ToolSet {
  if (!requested || requested.length === 0) return all;
  const keep = new Set([...requested, ...SPECIALIST_CORE_TOOLS]);
  const scoped = Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k)));
  return Object.keys(scoped).length > 0 ? scoped : all;
}

/**
 * Runs a specialist's generation loop. The model is wrapped with the same
 * tool-result compression middleware the main agent uses (window + head/tail
 * truncation with file-offload recovery) — specialists are exactly where
 * heavy tool use (large file reads, run_command/web_fetch output) happens
 * across up to `maxSteps` steps, so leaving them uncompressed was the
 * largest context-bloat gap. Offload dumps are scoped by `specialistId` so
 * they're cleaned up independently of the parent chat's dumps.
 *
 * Deliberately does NOT wrap with RAG/memory middleware — specialists are
 * stateless, task-scoped sub-agents and get their context via
 * `contextSnapshot` and Core Memory instead of per-turn vector retrieval.
 */
async function executeSpecialist(
  taskDescription: string,
  contextSnapshot: string,
  tools?: ToolSet,
  agentId: string = 'default',
  maxStepsOverride?: number,
  specialistId?: string,
  allowedToolNames?: string[],
): Promise<SpecialistResult> {
  // Task-scoped tool subset (#19 part 3) — narrow the inherited set to what the
  // task needs before the defensive spawn/todo strip below.
  const scopedInput = tools ? scopeToolsByNames(tools, allowedToolNames) : tools;

  // Sub-agents must never be able to spawn further specialists, regardless of
  // what tools the parent passed down. Strip spawn/await tools defensively.
  //
  // The inherited todo_* tools close over the *parent's* chatId scope, so a
  // specialist writing todos would clobber/leak into the main agent's list. Strip
  // them out here and rebuild them below with the specialist's own scope.
  const specialistTools = scopedInput
    ? Object.fromEntries(
        Object.entries(scopedInput).filter(
          ([k]) => k !== 'spawn_specialist' && k !== 'await_specialists' && !TODO_TOOL_NAMES.has(k),
        ),
      )
    : scopedInput;

  // Give the specialist todo tools scoped to its own id so two specialists in the
  // same chat keep independent lists and never surface in the main agent's
  // chat-scoped todo-check. Only when we have both an id to scope by and a tool
  // set to attach to — legacy callers without a specialistId simply get no todo
  // tools (better than writing to the parent's list).
  if (specialistTools && specialistId) {
    Object.assign(specialistTools, getTodoTools({ todoScopeId: specialistId }));
  }

  const sm = agentRegistry.getSoulManager(agentId);
  const agentConfig = sm.getConfig();
  const models = resolveModelList(agentConfig.model, agentConfig.fallbacks);

  // Mirror the agent's allowedSkills restriction into the summary — skill_get
  // (the tool a specialist would actually call) already enforces this
  // allowlist, so advertising unrestricted skills here was a prompt/behavior
  // inconsistency: the specialist could see a skill listed, try to load it,
  // and be refused.
  const skillsSummary = await getSkillsSummary(agentConfig.allowedSkills);
  const agentSoul = sm.getContent();
  const memoryContent = memoryManager.getContent();

  // Task lives ONLY in the user message (below) — it used to also be
  // repeated here under "## Your Task", duplicating the same text twice in
  // every specialist prompt for no benefit. System holds role/context/skills;
  // the user message is exclusively the task.
  const system = [
    '## Role',
    'You are a focused sub-agent (specialist). Complete ONLY the task assigned to you (given in the user message).',
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
    '## Result Contract',
    'End your response with a "## Result" section (must be the last section) containing: ' +
      '(1) a concise summary of what you did and found, and ' +
      '(2) a list of any files/artifacts you produced or modified, with full paths. ' +
      'This section is never truncated when your result is merged back into the supervisor\'s ' +
      'conversation, so put everything the supervisor needs to act on your work inside it — ' +
      'earlier exploratory/working text may be cut if long.',
  ].join('\n');

  const toolKeys = specialistTools ? Object.keys(specialistTools) : [];
  const maxSteps = maxStepsOverride ?? configManager.get().llm?.maxSteps ?? 50;
  const maxTokens = configManager.get().llm?.maxTokens ?? undefined;

  const abortController = specialistId ? cancellationRegistry.register(specialistId) : undefined;

  // Progressive staging needs a per-step id scoped to the run, which requires a
  // specialistId. Without one, no steps are emitted anyway, so stay on generateText.
  const progressiveSteps = configManager.get().llm?.progressiveSteps === true;
  const useProgressive = progressiveSteps && !!specialistId;
  const makeStepId = (n: number) => `${specialistId}:specialist:${n}`;

  let lastError = '';
  const skipProviders = new Set<string>();
  try {
  for (const resolved of models) {
    const provider = parseModelString(resolved.modelString)?.provider;
    if (provider && skipProviders.has(provider)) {
      console.log(`[Specialist] Skipping ${resolved.modelString} — same provider as a non-retryable failure`);
      continue;
    }
    try {
      let stepIndex = 0;
      const genArgs: Parameters<typeof generateText>[0] = {
        model: wrapModelWithToolCompression(resolved.model, specialistId),
        system,
        messages: [{ role: 'user' as const, content: taskDescription }],
        maxRetries: 2,
        ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
        ...(abortController ? { abortSignal: abortController.signal } : {}),
        ...(toolKeys.length > 0
          ? { tools: specialistTools, toolChoice: 'auto' as const, stopWhen: stepCountIs(maxSteps) }
          : {}),
        onStepFinish: (step: StepView) => {
          if (specialistId) {
            const n = ++stepIndex;
            const stepId = useProgressive ? makeStepId(n) : undefined;
            emitStep({
              id: stepId ?? crypto.randomUUID(),
              stage: useProgressive ? 'done' : undefined,
              sessionId: specialistId,
              timestamp: new Date().toISOString(),
              stepIndex: n,
              finishReason: step.finishReason,
              text: step.text || undefined,
              reasoning: step.reasoningText ?? undefined,
              toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
              toolResults: mapStepToolResults(step),
              specialistId,
              phase: 'specialist',
              ...extractUsage(step.usage),
              model: resolved.modelString,
            });
          }
        },
      };

      const result: GenerationResult = useProgressive
        ? await runStreamedGeneration(genArgs, {
            sessionId: specialistId as string,
            specialistId,
            phase: 'specialist',
            model: resolved.modelString,
            makeStepId,
          })
        : await generateText(genArgs);

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
      // Propagate AbortError so the outer caller can skip the completion emit.
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[Specialist] Model ${resolved.modelString} failed:`, lastError);
      if (isNonRetryableSameProvider(err) && provider) skipProviders.add(provider);
    }
  }

  throw new Error(`All specialist models failed. Last error: ${lastError}`);
  } finally {
    if (specialistId) {
      cancellationRegistry.unregister(specialistId);
      // Clear the specialist's own scoped todo file so {specialistId}.json files
      // don't accumulate in the workspace. Safe even if none was created.
      todoManager.clear(specialistId);
    }
  }
}

/** Thrown by {@link raceWithTimeout} when a specialist is aborted for exceeding its time budget. */
export class SpecialistTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Specialist timed out after ${timeoutMs / 1000}s`);
    this.name = 'SpecialistTimeoutError';
  }
}

/**
 * Races a specialist's execution promise against a timeout. Unlike a plain
 * `Promise.race`, when the timeout wins we actively abort the losing branch
 * via the cancellation registry and await its settlement before returning —
 * otherwise the specialist keeps generating, calling tools, and burning
 * tokens/state after the caller has already reported a timeout failure (it
 * could even emit a 'completed' job status after the parent reported
 * failure). Rejects with {@link SpecialistTimeoutError} on timeout.
 */
async function raceWithTimeout(
  specialistId: string | undefined,
  timeoutMs: number,
  execPromise: Promise<SpecialistResult>,
): Promise<SpecialistResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (specialistId) cancellationRegistry.cancel(specialistId);
      reject(new SpecialistTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([execPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof SpecialistTimeoutError) {
      // Await the losing branch so its `finally` cleanup (cancellation
      // registry unregister + scoped todo clear) completes deterministically
      // before we hand control back to the caller.
      await execPromise.catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  specialistId?: string; // Pre-assigned ID (used by workflow nodes to link to a pre-created job record)
  turnId?: string; // Conversation turn that triggered this spawn (links runs to the Thought Stream turn)
  allowedToolNames?: string[]; // Task-scoped tool subset (#19 part 3); undefined = inherit the full parent set
}

/**
 * Depth/permission gate shared by the synchronous spawnSpecialist path and
 * the inline background-fork path (createSpecialistTools) — was previously
 * duplicated verbatim in both. Throws when spawning isn't allowed; no-op at
 * depth <= 1 (the normal, unrestricted case).
 */
function assertSpawnAllowed(depth: number, spawningAgentId: string | undefined, targetAgentId: string): void {
  if (depth <= 1) return;
  // Absolute hard cap — sub-agents cannot spawn further specialists
  if (depth > 2) throw new Error('Max agent call depth reached (depth limit is 2)');
  // Require the running agent to have explicitly opted in to sub-agent spawning
  if (!spawningAgentId) throw new Error('Sub-agent spawning requires canSpawnSubAgents to be enabled on this agent');
  const spawningConfig = agentRegistry.getSoulManager(spawningAgentId).getConfig();
  if (!spawningConfig.canSpawnSubAgents) {
    throw new Error(`Agent "${spawningAgentId}" is not configured to spawn sub-agents (enable canSpawnSubAgents)`);
  }
  // undefined allowedSubAgents means "all agents allowed" (no restriction)
  if (spawningConfig.allowedSubAgents !== undefined && !spawningConfig.allowedSubAgents.includes(targetAgentId)) {
    throw new Error(`Agent "${targetAgentId}" is not in the allowed sub-agents list for "${spawningAgentId}"`);
  }
}

/**
 * Spawns a stateless, constrained sub-agent to handle a focused task.
 * Includes Core Memory (MEMORY.md) for operational context; no RAG. Result is returned as a plain string.
 */
export async function spawnSpecialist(options: SpecialistOptions & { parentSessionId?: string }): Promise<string> {
  const { taskDescription, contextSnapshot, depth, tools, timeoutMs = configManager.get().llm?.specialistTimeoutMs ?? 600_000, parentSessionId = 'unknown', agentId = 'default', maxStepsOverride, spawningAgentId, parentSpecialistId, turnId, allowedToolNames } = options;

  assertSpawnAllowed(depth, spawningAgentId, agentId ?? 'default');

  const specialistId = options.specialistId ?? crypto.randomUUID();
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
    turnId,
  });

  try {
    const result = await raceWithTimeout(
      specialistId,
      timeoutMs,
      executeSpecialist(taskDescription, contextSnapshot, tools, agentId, maxStepsOverride, specialistId, allowedToolNames),
    );

    if (result.hitMaxSteps) {
      // Emit max_steps event with resume capability
      emitSpecialist({
        id: crypto.randomUUID(),
        kind: 'max_steps',
        specialistId,
        parentSessionId,
        taskDescription,
        result: result.text,
        durationMs: Date.now() - startMs,
        maxStepsUsed: result.maxStepsUsed,
        canResume: true,
        timestamp: new Date().toISOString(),
        parentSpecialistId,
        agentId: agentId === 'default' ? undefined : agentId,
        modelUsed: result.modelUsed,
        turnId,
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
      result: result.text,
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
      parentSpecialistId,
      agentId: agentId === 'default' ? undefined : agentId,
      modelUsed: result.modelUsed,
      turnId,
    });

    return result.text;
  } catch (err) {
    // Re-throw AbortError — the cancel was already handled by the scheduler
    // which emits the 'cancelled' specialist event. We must not emit a
    // spurious 'error' event that would overwrite the 'cancelled' state.
    if (err instanceof Error && err.name === 'AbortError') {
      throw err;
    }
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
      turnId,
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
  turnJobIds?: Set<string>,
  turnId?: string,
): ToolSet {
  const isInsideBackgroundTask = !!currentSpecialistId;

  // Shared map for inline specialists spawned within this execution context.
  // Only populated when isInsideBackgroundTask is true.
  const inFlight = new Map<string, InFlightEntry>();

  const specialistTimeoutMs = configManager.get().llm?.specialistTimeoutMs ?? 600_000; // 10 min default

  const spawn_specialist = tool({
    description:
      'Delegate a focused analysis or data-processing task to a specialist sub-agent. ' +
      'Use when you need deep analysis, log parsing, or multi-step reasoning on a specific topic ' +
      'and want to keep the main conversation clean. The specialist works independently and returns a summary. ' +
      (isInsideBackgroundTask
        ? 'Set background: true to start the specialist without waiting for it — then call await_specialists with the returned job IDs to collect all results at once, enabling parallel execution.'
        : 'Set background: true to run asynchronously. You get a job ID immediately and can reply to the user at once. ' +
          'A single background specialist delivers its result directly to the user as a new message. ' +
          'Multiple background specialists spawned in the same turn are automatically collected and synthesized into one cohesive response.'),
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
            : 'If true, run the specialist asynchronously. Returns a job ID immediately so you can respond to the user right away. ' +
              'A single background specialist delivers its output directly to the user. ' +
              'When you spawn multiple background specialists in the same turn, their results are automatically synthesized into one combined response. ' +
              'Use for long tasks or to run multiple specialists in parallel.',
        ),
      agent_id: z
        .string()
        .optional()
        .describe('Agent to use for this specialist. Defaults to the current active agent.'),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          'Optional task-scoped tool subset — the exact tool names this specialist needs (e.g. ["web_search","web_fetch"]). ' +
          'Keeps the specialist focused and cheaper by not shipping all tool schemas. ' +
          'Basic file/terminal tools are always included. Omit to give the specialist the full tool set.',
        ),
    }),
    execute: async (input: { task_description: string; context_snapshot: string; background?: boolean; agent_id?: string; tools?: string[] }) => {
      // Validate agent_id before dispatching — fail fast with a helpful error.
      if (input.agent_id && !agentRegistry.agentExists(input.agent_id)) {
        const available = agentRegistry.listAgents().map((a) => a.id);
        return `Error: specialist agent "${input.agent_id}" not found.${available.length ? ` Available agents: ${available.join(', ')}.` : ' No agents are configured.'}`;
      }

      if (!input.background) {
        // Synchronous path — blocks until the specialist finishes.
        // Use a longer timeout when we're already inside a background task.
        const timeoutMs = specialistTimeoutMs;
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
          turnId,
          allowedToolNames: input.tools,
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

        // Human-readable combined description for the job record/dashboard
        // only — executeSpecialist takes task_description and
        // context_snapshot as separate arguments so the context isn't
        // duplicated into both the "task" and a concatenated blob (see the
        // Result Contract / de-duplication note on executeSpecialist).
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
          turnId,
        });

        // Create job record so the dashboard and resume flow work.
        await createJob({ chatId, status: 'running', taskDescription: enrichedDescription }, specialistId);

        // Build the inline execution promise. We don't await it here.
        const agentId = input.agent_id ?? 'default';
        const promise: Promise<string> = (async () => {
          try {
            // Depth-limit check (same logic as spawnSpecialist, via the
            // shared assertSpawnAllowed helper)
            const depth = currentDepth + 1;
            assertSpawnAllowed(depth, spawningAgentId, agentId);

            const result = await raceWithTimeout(
              specialistId,
              specialistTimeoutMs,
              executeSpecialist(input.task_description, input.context_snapshot, availableTools, agentId, undefined, specialistId, input.tools),
            );

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
              result: text,
              durationMs: Date.now() - startMs,
              maxStepsUsed: result.hitMaxSteps ? result.maxStepsUsed : undefined,
              canResume: result.hitMaxSteps,
              timestamp: new Date().toISOString(),
              parentSpecialistId: currentSpecialistId,
              agentId: agentId === 'default' ? undefined : agentId,
              modelUsed: result.modelUsed,
              turnId,
            });

            const status = result.hitMaxSteps ? 'max_steps_reached' : 'completed';
            await updateJobStatus(specialistId, status, text, undefined, result.hitMaxSteps ? result.maxStepsUsed : undefined);

            return text;
          } catch (err) {
            // Re-throw AbortError so the cancel flow handles the event emission.
            if (err instanceof Error && err.name === 'AbortError') {
              throw err;
            }
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
              turnId,
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
        turnId,
      });

      await createJob({
        chatId,
        status: 'pending',
        taskDescription: enrichedDescription,
      }, specialistId);

      turnJobIds?.add(specialistId);

      await schedulerService.scheduleOnce(specialistId, chatId, enrichedDescription, 0, { specialistId, agentId: input.agent_id, spawningAgentId, parentSpecialistId: currentSpecialistId, turnId, specialistToolNames: input.tools });

      return JSON.stringify({
        jobId: specialistId,
        status: 'started',
        message: `Specialist is running in the background (ID: ${specialistId}). I'll deliver the results when it completes.`,
      });
    },
  });

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
    }),
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
  });

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
