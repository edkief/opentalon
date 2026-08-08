import { generateText, stepCountIs, APICallError } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { agentRegistry } from '../soul';
import { configManager } from '../config';
import { memoryManager } from './memory-manager';
import { wrapModelWithToolCompression } from './middleware';
import type { Message, ChatOptions, ChatResponse, ExecutorConfig, StepView, GenerationResult } from './types';
import { emitStep, mapStepToolResults } from './log-bus';
import { extractUsage } from './usage';
import { runStreamedGeneration } from './streamed-step';
import { toModelMessages } from './turn-parts';
import { setRagContext, consumeRagContext } from './rag-store';
import { retrieveContext } from '../memory';
import { resolveModelList, parseModelString, resolveAuxModel } from './model-resolver';
import type { ResolvedModel } from './model-resolver';
import { todoManager } from './todo-manager';
import { listSkills } from '../tools';
import { db } from '../db';
import { workflows as workflowsTable } from '../db/schema';
import { ne, inArray } from 'drizzle-orm';
import { cancellationRegistry } from './cancellation';
import { getRunningJobsForChat } from '../db/jobs';
import { makeAmendTool } from '../tools/finalise';
import { registerSpecialistBatch } from './specialist-batch';
import { schedulerService } from '../scheduler';
import { buildAttributionReport, countTokensAnthropic, formatAttributionTable } from './context-attribution';
import { logger } from '../telemetry';
import { createDeferredToolControls, initialActiveTools } from '../tools/deferred';

/**
 * Strip thinking/reasoning tokens that some models emit.
 * Handles: <think>...</think>, <thinking>...</thinking>, <reflection>...</reflection>,
 * and <reasoning>...</reasoning> — all case-insensitive, including multi-line blocks.
 */
function stripThinkingTokens(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    // A model cut off mid-block (hit the token limit while "thinking") leaves
    // an unterminated opening tag with no matching close — the rules above
    // never match it, leaking the entire partial block to the user. Strip
    // from the last unterminated opening tag to end-of-string.
    .replace(/<(?:think|thinking|reflection|reasoning)>[\s\S]*$/gi, '')
    .trim();
}

/**
 * Classifies a generation failure so the fallback loop can short-circuit
 * provably deterministic failures instead of hopping to N more models with
 * the same full-context cost and a guaranteed identical error:
 *   - rate-limited/overloaded (429/529): the AI SDK already retries these
 *     internally (see `maxRetries` in genArgs); if it still surfaces, it's
 *     worth noting but not worth skipping other providers over.
 *   - non-retryable + 400/401/403 (bad request, auth failure, forbidden):
 *     will fail identically on every other model from the *same provider*
 *     (bad API key, content policy, malformed replayed history) — skip
 *     remaining same-provider fallbacks. Different providers may still work
 *     (e.g. a key that's only bad for one provider), so this never skips ALL
 *     fallbacks, only same-provider ones.
 * Conservative by default: anything else still falls back as before.
 */
function classifyError(err: unknown): { message: string; tag?: string; skipSameProvider: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 429 || status === 529) {
      return { message, tag: 'rate-limited', skipSameProvider: false };
    }
    if (err.isRetryable === false && (status === 400 || status === 401 || status === 403)) {
      const tag = status === 401 ? 'auth failure' : status === 403 ? 'forbidden' : 'invalid request';
      return { message, tag, skipSameProvider: true };
    }
  }
  return { message, skipSameProvider: false };
}

/**
 * Truncates a specialist's result text for merging into the parent's
 * response, but keeps a trailing "## Result" section (the summary +
 * produced-file-paths contract specialists are instructed to end with —
 * see the "## Result Contract" guidance in specialist.ts) fully intact.
 * Without this, the char cap could truncate mid-way through exactly the
 * artifact paths/summary the supervisor needs, with no signal beyond "...".
 * Falls back to plain truncation when no "## Result" section is present.
 */
function truncateSpecialistResult(text: string, maxChars: number): string {
  const marker = '## Result';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) {
    return text.length > maxChars ? text.slice(0, maxChars) + '...[truncated]' : text;
  }
  const body = text.slice(0, idx);
  const resultSection = text.slice(idx);
  if (body.length <= maxChars) return text;
  return `${body.slice(0, maxChars)}...[truncated]\n\n${resultSection}`;
}

function normalizeReasoning(rawReasoning: unknown): string | undefined {
  if (rawReasoning == null) return undefined;

  let result: string | undefined;

  if (typeof rawReasoning === 'string') {
    result = rawReasoning.trim() || undefined;
  } else if (typeof rawReasoning === 'object') {
    if (Array.isArray(rawReasoning)) {
      // step.reasoning in ai@6 is always Array<ReasoningPart> — each item is
      // {type:'reasoning', text:string} or {type:'redacted_thinking'/'redacted', data:...}.
      // Use step.reasoningText (the pre-joined string) when the array is non-empty but
      // every item maps to empty (all redacted), falling back item-by-item.
      const parts = rawReasoning
        .map((item) => {
          if (item == null || typeof item !== 'object') return String(item).trim();
          const r = item as Record<string, unknown>;
          if (typeof r.text === 'string') return r.text.trim();
          if (typeof r.content === 'string') return r.content.trim();
          if (typeof r.value === 'string') return r.value.trim();
          // Redacted thinking blocks have no displayable text — skip them
          if (r.type === 'redacted' || r.type === 'redacted_thinking') return '';
          return JSON.stringify(r);
        })
        .filter(Boolean);
      result = parts.length > 0 ? parts.join('\n') : undefined;
    } else {
      const r = rawReasoning as Record<string, unknown>;
      if (typeof r.text === 'string') result = r.text.trim() || undefined;
      else if (typeof r.content === 'string') result = r.content.trim() || undefined;
      else if (typeof r.value === 'string') result = r.value.trim() || undefined;
      else result = JSON.stringify(r, null, 2) || undefined;
    }
  } else {
    result = String(rawReasoning).trim() || undefined;
  }

  // Final safety: reject any value that is clearly a stringified object reference
  // (produced by old String(array) coercion before this function existed).
  if (!result || result === '[object Object]') return undefined;
  return result;
}

export class LLMExecutor {
  private config: ExecutorConfig;

  constructor(config: ExecutorConfig = {}) {
    this.config = config;
  }

  /**
   * Builds the system prompt as two blocks so provider prompt caches key on a
   * stable prefix:
   *   - `stable`: identity, soul, core memory, per-turn context, framework
   *     instructions, tools environment, and agents/skills/workflows lists.
   *     Byte-identical across every step of a turn (main/finalise/todo-check)
   *     and across turns until the agent's config or Core Memory changes.
   *   - `volatile`: current date/time (minute granularity), active todos, and
   *     running background specialists — content that can legitimately change
   *     step-to-step within a single turn.
   * Emitted as two separate system messages (the AI SDK accepts multiple)
   * rather than concatenated, so the stable block's cache-control breakpoint
   * covers exactly the stable tokens.
   */
  async getSystemPrompt(context: string = '', agentId: string = 'default', chatId?: string, statelessSpecialist: boolean = false): Promise<{ stable: string; volatile: string }> {
    const sm = agentRegistry.getSoulManager(agentId);
    const agentConfig = sm.getConfig();
    const agentContent = sm.getContent();

    // Stateless specialists receive no Core Memory — the supervisor is
    // responsible for handing relevant excerpts via `supervisorContext`. Keeps
    // specialists from silently inheriting the parent's persistent state.
    const memoryContent = statelessSpecialist ? '' : memoryManager.getContent();

    const stableParts: string[] = [];
    if (agentContent) stableParts.push(agentContent);
    if (memoryContent) stableParts.push(`\n\n## Core Memory\n${memoryContent}`);
    if (context) stableParts.push(`\n\nContext: ${context}`);

    stableParts.push(`

## Task execution
For quick tasks (single tool call, simple questions), respond directly. For multi-step or long-running tasks, prefer spawning a background specialist via spawn_specialist with background: true and immediately reply with a brief acknowledgement — this frees you to handle new messages while the task runs. For multi-step tasks you handle directly, use todo_create to set a goal and task list before starting work, then call todo_update to mark items done as you progress.

Todo lists are per-task, not permanent: a leftover list is cleared at the next user message once it is fully done, or once it has gone untouched for ~30 minutes with no background specialists running (a recently-updated list survives, so pausing mid-task to ask the user something is safe). If you delegate a todo item to a background specialist, link it by calling todo_update with waiting_on_job_id set to the job ID returned by spawn_specialist — the item then shows as delegated (in progress, not dropped), and when the specialist completes you will be re-invoked with the list so you can mark it done and continue the remaining items. Ending your turn with pending items that are delegated to running background jobs is normal and correct — reply to the user and stop.`);
    stableParts.push(`

## Spawning Specialists Agents and Scheduling Tasks
- You can spawn specialist agents to delegate work using the spawn_specialist tool and schedule tasks using the schedule_task tool
- **Background specialists**: results are delivered automatically to this conversation when complete — do not re-check, re-spawn, or redo their work. Any currently running specialists are listed in a separate "Background Specialists In Progress" note below, if any are active. After spawning, tag any todo items the specialist is handling via todo_update with waiting_on_job_id (see Task execution above).
- **Scheduled tasks** (cron): never assume a schedule exists based on chat history alone — verify with the scheduling tools before creating or modifying one.`);

    if (!statelessSpecialist) {
      stableParts.push(`

## Memory policy
You have two persistent stores. Choosing the right one — or neither — is your job; nothing is written automatically.
- **Core Memory** (\`memory_append store:'core'\` → MEMORY.md, injected every request): durable identity, standing rules, and stable preferences. Keep it lean. Example: *user states a standing preference ("always reply in metric units") → core.*
- **Recall** (\`memory_append store:'recall'\` → searchable notes, surfaced only when relevant): episodic, dated knowledge worth finding again. Examples: *resolved a non-obvious error/bug → recall; concluded an analysis or learned a durable fact about a system or person → recall.*
- **Nothing**: routine chit-chat, ephemeral task chatter, and anything already captured in the conversation itself. When in doubt, don't write — an over-full store makes everything harder to find.

Reach for **\`memory_recall\`** when the user references past work you don't see in the current conversation, mentions an unfamiliar entity you may have notes on, or before re-deriving something you have plausibly already worked out and saved. Relevant recalled notes are also injected automatically under "## Recalled notes" when they match — \`memory_recall\` is for deliberate, deeper queries.

## Delegating with context and memory
When delegating to a specialist via \`spawn_specialist\`, \`task_description\` must be self-contained and \`context_snapshot\` is the specialist's ONLY memory/context handoff: specialists do not see this conversation, do not see recalled RAG notes, do not see Core Memory, and have no memory tools. Before spawning, if the task depends on prior work or durable facts, call \`memory_recall\` and/or \`memory_read\` yourself, then include only the relevant excerpts under a labelled \`## Relevant memory\` section in \`context_snapshot\`. Do NOT paste the full MEMORY.md. Do NOT include secrets — the snapshot may be retained in job/orchestration records. After reviewing a specialist's result, save any durable findings with your own memory tools.`);
    } else {
      stableParts.push(`

## Memory policy (disabled for this specialist run)
You are running as a stateless specialist. You have NO access to Core Memory (MEMORY.md) or RAG; memory tools have been removed from your tool set. The supervisor pre-loaded any context you need under \`## Context from Supervisor\` in your task message — use only what is there. Do not call memory tools (they are unavailable). After you return a result, the supervisor decides whether to save anything durable.`);
    }

    if (agentConfig.injectAvailableAgents && !statelessSpecialist) {
      const allAgents = agentRegistry.listAgents().filter(a => a.id !== agentId);
      if (allAgents.length > 0) {
        const agentLines = allAgents
          .map(a => `- **${a.id}**${a.description ? `: ${a.description}` : ''}`)
          .join('\n');
        stableParts.push(`\n\n## Available Agents\nYou can delegate tasks to the following agents using the spawn_specialist tool with the agent_id parameter:\n${agentLines}`);
      }
    }

    if (agentConfig.injectSkills) {
      let skills = await listSkills();
      if (Array.isArray(agentConfig.allowedSkills)) {
        skills = skills.filter(s => (agentConfig.allowedSkills as string[]).includes(s.name));
      }
      if (skills.length > 0) {
        const skillLines = skills.map(s => `- **${s.name}**: ${s.description}`).join('\n');
        stableParts.push(`\n\n## Available Skills\nUse skill_get to load a skill's instructions before executing it:\n${skillLines}`);
      }
    }

    if (agentConfig.injectWorkflows) {
      const allowedWf = agentConfig.allowedWorkflows;
      const rows = await (Array.isArray(allowedWf) && allowedWf.length > 0
        ? db.select({ id: workflowsTable.id, name: workflowsTable.name, description: workflowsTable.description })
            .from(workflowsTable).where(inArray(workflowsTable.id, allowedWf))
        : Array.isArray(allowedWf) && allowedWf.length === 0
          ? Promise.resolve([])
          : db.select({ id: workflowsTable.id, name: workflowsTable.name, description: workflowsTable.description })
              .from(workflowsTable).where(ne(workflowsTable.status, 'archived')));
      if (rows.length > 0) {
        const wfLines = rows.map(w => `- **${w.id}** (${w.name})${w.description ? `: ${w.description}` : ''}`).join('\n');
        stableParts.push(`\n\n## Available Workflows\nUse workflow_run to trigger a workflow by id:\n${wfLines}`);
      }
    }

    stableParts.push(`

## Persistent Tools Environment
The following directories on the workspace PVC survive pod restarts and are on your PATH:
- \`/workspace/tools/bin\` — custom binaries and shell wrappers (on PATH)
- \`/workspace/tools/lib/python\` — Python packages (\`PIP_TARGET\` is set here; bare \`pip install <pkg>\` lands here)
- \`/workspace/tools/lib/node/node_modules\` — npm globals (\`npm_config_prefix\` is set; bare \`npm install -g <pkg>\` lands here)
- \`/workspace/tools/share\` — misc data files

**Installing tools persistently:**
- Python: \`pip install <pkg>\` (no flags needed — PIP_TARGET is pre-set)
- npm: \`npm install -g <pkg>\`
- Static binary: \`curl -Lo /workspace/tools/bin/<name> <url> && chmod +x /workspace/tools/bin/<name>\`

**Do not use \`apt-get\`** to install tools — apt writes to the container's ephemeral layer and is lost on pod restart. If a package truly requires apt, request it be added to the base image.

## Shell command execution
Guidance for the \`run_command\` tool (kept here, once, rather than repeated in every tool schema):
- **Approval:** dangerous commands require user approval before they run; a denial or approval timeout is reported back to you so you can adjust or offer to retry.
- **Timeout:** long-running commands are killed after a configurable timeout (\`tools.commandTimeoutMs\`). Plan around it — run long work in the background (e.g. \`nohup … &\`) or split it into steps. The killed-after message tells you the exact limit at runtime.
- **Environment variables:** \`TELEGRAM_CHAT_ID\` and \`TELEGRAM_BOT_TOKEN\` are available. If a GitHub token is configured, \`GH_TOKEN\` and \`GITHUB_TOKEN\` are set (bare token) — use them for \`gh\` and the GitHub API instead of reading \`.git-credentials\`.`);

    // ── Volatile tail: changes step-to-step within a turn, kept out of the
    // cached stable block. Timestamp is minute-granularity — second precision
    // bought nothing and busted the cache on every single request.
    const volatileParts: string[] = [];
    const timezone = configManager.get().timezone ?? 'UTC';
    const now = new Date();
    const localDatetime = now.toLocaleString('en-AU', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
    volatileParts.push(`## Current date & time\n${localDatetime} (${timezone})`);

    const todoSummary = chatId ? todoManager.getSummary(chatId) : '';
    if (todoSummary) volatileParts.push(`\n\n## Active Todos\n${todoSummary}`);

    if (chatId) {
      try {
        const runningJobs = await getRunningJobsForChat(chatId);
        if (runningJobs.length > 0) {
          const jobLines = runningJobs
            .map((j) => `- \`${j.id}\` (${j.status}): ${j.taskDescription?.split('\n')[0]?.slice(0, 80) ?? 'task'}`)
            .join('\n');
          volatileParts.push(`\n\n## Background Specialists In Progress\nThese specialists are currently running for this conversation — do NOT re-spawn or duplicate their work:\n${jobLines}`);
        }
      } catch {
        // Non-fatal: job lookup failure must not break system prompt generation.
      }
    }

    return { stable: stableParts.join(''), volatile: volatileParts.join('') };
  }

  /**
   * Precedence: executor config (per-call override) → agent config (soul.yaml
   * temperature) → global config.yaml llm.temperature → default. A per-agent
   * temperature previously could never take effect once the global config set
   * one — backwards from every other per-agent setting (model, fallbacks,
   * skills all let the agent override the global default).
   */
  private getTemperature(agentId: string = 'default'): number {
    const sm = agentRegistry.getSoulManager(agentId);
    return (
      this.config.temperature ??
      sm.getConfig().temperature ??
      configManager.get().llm?.temperature ??
      0.7
    );
  }

  private isMemoryEnabled(): boolean {
    return (
      (configManager.get().memory?.enabled ?? process.env.ENABLE_MEMORY === 'true')
    );
  }

  private getForkAndWaitGuidance(): string {
    return `

## Fork-and-Wait for Parallel Sub-Tasks
You are running as a background specialist. When you need multiple sub-tasks done in parallel:
1. Call spawn_specialist with background:true for each sub-task — you get a jobId immediately.
2. After spawning all of them, call await_specialists with the list of jobIds to block until all finish.
3. Use the returned results to decide your next steps.

**Do NOT start doing the work yourself after spawning specialists** — wait for await_specialists to return their results first. Proceeding without waiting duplicates work and produces conflicting outputs.`;
  }

  /**
   * Build the final response text by appending completed specialist results.
   * Called after generateText completes (both primary and fallback paths).
   * Only awaits background specialists when running as a background specialist
   * (specialistId is set) — the main user-facing agent returns immediately.
   */
  private async finalizeResponseWithSpecialists(
    baseText: string,
    chatId?: string,
    showThinking = false,
    turnJobIds?: Set<string>,
    isBackgroundSpecialist = false,
    agentId?: string,
    originalRequest?: string,
  ): Promise<string> {
    if (isBackgroundSpecialist) {
      if (!chatId || !turnJobIds || turnJobIds.size === 0) return showThinking ? baseText : stripThinkingTokens(baseText);
      const specialistResults = await this.awaitPendingSpecialists(turnJobIds);
      const stripped = showThinking ? baseText : stripThinkingTokens(baseText);
      return stripped + specialistResults;
    }

    // Main agent: register a batch so completions are grouped and tied back to this request.
    if (chatId && turnJobIds && turnJobIds.size > 0) {
      registerSpecialistBatch({
        chatId,
        agentId,
        jobIds: [...turnJobIds],
        originalRequest: originalRequest ?? '',
      }).catch((err) => console.error('[LLMExecutor] registerSpecialistBatch failed', err));
    }

    return showThinking ? baseText : stripThinkingTokens(baseText);
  }

  /**
   * Wait for background specialists spawned during this turn to complete.
   * Only waits for the job IDs in turnJobIds — never picks up jobs from
   * previous turns. Event-driven via schedulerService.waitForJobs (Postgres
   * LISTEN/NOTIFY) instead of polling the jobs table every 2s.
   */
  private async awaitPendingSpecialists(turnJobIds: Set<string>, maxWaitMs = 120_000): Promise<string> {
    const ids = [...turnJobIds];
    const resolved = await schedulerService.waitForJobs(ids, maxWaitMs);

    const completedJobs = ids
      .map((id) => resolved.get(id))
      .filter((job): job is NonNullable<typeof job> => !!job && (job.status === 'completed' || job.status === 'max_steps_reached'));

    if (completedJobs.length === 0) {
      const stillPending = ids.filter((id) => !resolved.get(id));
      if (stillPending.length > 0) {
        console.log(`[LLMExecutor] awaitPendingSpecialists timed out after ${maxWaitMs}ms for ${stillPending.length} job(s)`);
      }
      return '';
    }

    const resultCap = configManager.get().llm?.specialistResultTruncateChars ?? 3000;
    const results = completedJobs
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      .map((job) => {
        const taskLabel = job.taskDescription?.split('\n')[0]?.slice(0, 80) ?? 'Task';
        const truncated = truncateSpecialistResult(job.result ?? '', resultCap);
        return `[${taskLabel}]\n${truncated}`;
      })
      .join('\n\n');

    return `\n\n## Specialist Results\n\n${results}`;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Fail-safe: refuse to process if config has a syntax error
    if (!configManager.isValid()) {
      throw new Error(`[Config] Invalid configuration: ${configManager.error}`);
    }

    const cfg = configManager.get().llm ?? {};
    const { messages, context = '', memoryScope, chatId, tools, agentId = 'default', modelOverride, specialistId, orchestrationRunId, abortSignal, turnJobIds, userInitiated, resumeMessages, statelessSpecialist = false, supervisorContext } = options;
    // Groups this turn's steps and links them to the conversation rows. Generated
    // here when the caller didn't supply one, and returned on the response.
    const turnId = options.turnId ?? crypto.randomUUID();
    const maxSteps = options.maxSteps ?? cfg.maxSteps ?? 10;
    const maxTokens = this.config.maxTokens ?? cfg.maxTokens ?? undefined;
    const showThinking = cfg.showThinking === true;
    // When enabled, steps stream through thinking → responding → done stages via
    // streamText, with the early stages shown live-only. When off, the classic
    // single-shot generateText path runs unchanged — the safe rollout default.
    // Persistence is identical either way: one row per step.
    const progressiveSteps = cfg.progressiveSteps === true;
    // Base for deterministic per-step ids, shared between the live fullStream
    // stages and the final onStepFinish emit so the thought stream replaces the
    // step row in place (live-only correlation; never persisted).
    const stepIdBase = turnId ?? specialistId ?? orchestrationRunId ?? chatId ?? 'web';
    const makeStepId = (phase: string, n: number) => `${stepIdBase}:${phase}:${n}`;
    const maybeStrip = (text: string) => (showThinking ? text : stripThinkingTokens(text));
    const originalRequest = [...messages].reverse().find((m) => m.role === 'user')?.content as string | undefined;

    // Register an AbortController for this specialist so the cancellation API can
    // interrupt the LLM mid-generation. Only register if the caller hasn't already
    // provided a signal (the specialist.ts inline path passes one explicitly).
    let ownController: AbortController | undefined;
    if (specialistId && !abortSignal) {
      ownController = cancellationRegistry.register(specialistId);
    }
    const effectiveAbortSignal = abortSignal ?? ownController?.signal;

    const sm = agentRegistry.getSoulManager(agentId);
    const agentConfig = sm.getConfig();

    const models = resolveModelList(
      modelOverride ?? this.config.model ?? agentConfig.model,
      modelOverride ? [] : agentConfig.fallbacks,
    );
    if (models.length === 0) {
      throw new Error('No LLM provider available — set at least one API key');
    }

    const [primary, ...fallbacks] = models;
    console.log(
      `[LLMExecutor] agent=${agentId} model=${primary.modelString} temp=${this.getTemperature(agentId)} maxSteps=${maxSteps}${maxTokens !== undefined ? ` maxTokens=${maxTokens}` : ''}${specialistId ? ` specialist=${specialistId}` : ''}`,
    );
    if (fallbacks.length) console.log(`[LLMExecutor] Fallbacks: ${fallbacks.map(m => m.modelString).join(', ')}`);

    // ── Todo fresh-start policy ─────────────────────────────────────────────
    // Todos are task-scoped, approximated with three signals; on a
    // user-initiated turn a leftover list is cleared unless the task is
    // plausibly still in flight:
    //   1. all items done                          → task finished, clear
    //   2. pending items, background jobs running  → delegated, keep (the
    //      synthesis turn needs the list to know what to resume)
    //   3. pending items, no jobs                  → keep only while fresh
    //      (updated within TODO_STALE_TTL_MS — covers the ask-clarify-continue
    //      flow); stale means abandoned, clear
    // Automated turns (cron, specialist, synthesis) never clear — they must
    // see the list they're resuming.
    if (userInitiated && chatId) {
      const leftoverList = todoManager.load(chatId);
      if (leftoverList) {
        const leftoverPending = todoManager.pendingItems(leftoverList);
        if (leftoverPending.length === 0) {
          todoManager.clear(chatId);
          console.log('[LLMExecutor] Cleared completed todo list at start of user turn');
        } else if (todoManager.isStale(leftoverList)) {
          const activeJobs = await getRunningJobsForChat(chatId).catch(() => []);
          if (activeJobs.length === 0) {
            todoManager.clear(chatId);
            console.log(`[LLMExecutor] Cleared stale todo list (${leftoverPending.length} pending item(s), no background jobs, untouched past TTL) at start of user turn`);
          }
        }
      }
    }

    const { stable: baseStableSystem, volatile: volatileSystem } = await this.getSystemPrompt(context, agentId, chatId, statelessSpecialist);
    // Append fork-and-wait guidance when running as a background specialist with sub-agent tools
    const stableSystemPrompt = specialistId && tools && 'spawn_specialist' in tools
      ? baseStableSystem + this.getForkAndWaitGuidance()
      : baseStableSystem;
    const temperature = this.getTemperature(agentId);
    // Auxiliary/control turns (max-steps summary, finalise, todo-check) are
    // constrained instruction-following tasks ("write a status update",
    // "call this one tool or don't"), not creative chat — a low temperature
    // makes tool-call arguments and structured output more reliable than the
    // chat-tuned main temperature.
    const auxTemperature = 0.2;
    const enableMemory = this.isMemoryEnabled();
    const agentRagEnabled = agentConfig.ragEnabled ?? true; // default: RAG enabled

    const additionalInstructions = agentConfig.additionalInstructions?.trim();
    // Stable block: identical across every step of this turn (and across turns
    // until agent config/soul/memory changes) — this is what a provider prompt
    // cache keys on, so volatile content (timestamp, todos, running jobs) must
    // never appear here. See volatileSystem below, emitted as a separate
    // trailing system message.
    const stableSystemContent = additionalInstructions
      ? `## Framework Instructions\n${stableSystemPrompt}\n\n## Additional Instructions\n${additionalInstructions}`
      : stableSystemPrompt;
    // Combined view used only for step-log display (systemPrompt field) — not
    // sent to the model as a single block.
    const systemContent = `${stableSystemContent}\n\n${volatileSystem}`;
    const mappedMessages = messages.flatMap(toModelMessages);

    // ── RAG: retrieve once per turn, not once per step. ─────────────────────
    // Hybrid retrieval used to run inside a per-doGenerate middleware, which
    // fired on every step of the multi-step loop and again in the
    // finalise/todo-check phases — up to `maxSteps + 2` retrievals for one
    // result. Do it once here, keyed on the last user message, and inject the
    // result directly into the message list (a user-adjacent block, not the
    // system message, so the cached stable system prefix stays byte-stable).
    // Skipped entirely for stateless specialists — the supervisor is
    // responsible for pre-loading relevant notes into `supervisorContext`.
    let injectedRagContext: string | undefined;
    if (enableMemory && memoryScope && chatId && agentRagEnabled && !statelessSpecialist) {
      const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim();
      if (lastUserText) {
        try {
          // No chatId filter (#25): curated notes are recalled across chats.
          const memoryContext = await retrieveContext({ query: lastUserText, scope: memoryScope, limit: 5, agent: agentId });
          if (memoryContext) {
            injectedRagContext = memoryContext;
            setRagContext(chatId, memoryContext);
            const contextSection = `## Recalled notes\n${memoryContext}\n\n`;
            for (let i = mappedMessages.length - 1; i >= 0; i--) {
              const m = mappedMessages[i];
              if (m.role === 'user' && typeof m.content === 'string') {
                mappedMessages[i] = { ...m, content: contextSection + m.content };
                break;
              }
            }
          }
        } catch (err) {
          console.error('[LLMExecutor] RAG retrieval failed:', err);
        }
      }
    }

    // Prepend the supervisor's context snapshot to the last user message so the
    // specialist sees it as part of the task. Kept out of the system prompt
    // (which is byte-stable for cache hits) and out of Core Memory / RAG. Only
    // used when the caller opted into stateless-specialist mode.
    if (statelessSpecialist && supervisorContext) {
      const ctxSection = `## Context from Supervisor\n${supervisorContext}\n\n`;
      for (let i = mappedMessages.length - 1; i >= 0; i--) {
        const m = mappedMessages[i];
        if (m.role === 'user' && typeof m.content === 'string') {
          mappedMessages[i] = { ...m, content: ctxSection + m.content };
          break;
        }
      }
    }

    const fullMessages: ModelMessage[] = [
      {
        role: 'system',
        content: stableSystemContent,
        // Cache-control breakpoint after the stable block. Anthropic-specific;
        // ignored by other providers (providerOptions are namespaced).
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'system', content: volatileSystem },
      ...mappedMessages,
      // Crash recovery: replay tool activity this turn already executed before a
      // restart, so the model continues rather than redoing it. Empty in the
      // normal (non-resumed) path. See src/lib/agent/resume.ts.
      ...(resumeMessages ?? []),
    ];
    if (resumeMessages?.length) {
      console.log(`[LLMExecutor] Resuming turn ${turnId} with ${resumeMessages.length} replayed message(s) from prior steps`);
    }

    const wrapModel = (model: LanguageModel): LanguageModel => wrapModelWithToolCompression(model, chatId);

    // ── #19 part 2: deferred / on-demand tool loading (opt-in) ──────────────
    // When enabled, only a small core plus the search_tools/load_tools meta-
    // tools are exposed to the model; the rest are withheld via a per-step
    // activeTools gate until the model loads them. The full tool set is still
    // built and executable — only the serialized schemas shrink. Off by default
    // → effectiveTools === tools and no prepareStep, i.e. byte-identical.
    const deferredEnabled =
      (configManager.get().tools?.deferredTools === true ||
        process.env.DEFERRED_TOOLS === '1' ||
        process.env.DEFERRED_TOOLS === 'true') &&
      !!tools &&
      Object.keys(tools ?? {}).length > 0;
    let effectiveTools = tools;
    let deferredActive: Set<string> | undefined;
    if (deferredEnabled && tools) {
      deferredActive = initialActiveTools(tools);
      effectiveTools = { ...tools, ...createDeferredToolControls(tools, deferredActive) };
      console.log(`[LLMExecutor] Deferred tool loading on: ${deferredActive.size}/${Object.keys(effectiveTools).length} tools active initially`);
    }

    const toolOptions = effectiveTools && Object.keys(effectiveTools).length > 0
      ? {
          tools: effectiveTools,
          toolChoice: 'auto' as const,
          stopWhen: stepCountIs(maxSteps),
          ...(deferredActive
            ? { prepareStep: () => ({ activeTools: [...deferredActive!] as (keyof typeof effectiveTools)[] }) }
            : {}),
        }
      : {};

    // ── #18 Context-size attribution (dev flag) ─────────────────────────────
    // Serialize the exact outgoing payload and log a ranked per-section token
    // table so tool-surface / description / memory optimisations can be ranked
    // by measured impact. Gated behind config llm.debugContextSize (or the
    // DEBUG_CONTEXT_SIZE env var) — off by default, zero cost when off. Runs
    // once here (per chat() call = one payload); the log header spells out how
    // this per-request size relates to cumulative turn usage.
    const debugContextSize =
      cfg.debugContextSize === true ||
      process.env.DEBUG_CONTEXT_SIZE === '1' ||
      process.env.DEBUG_CONTEXT_SIZE === 'true';
    if (debugContextSize) {
      try {
        const mcpPrefixes = (configManager.get().tools?.mcpServers ?? [])
          .map((s) => (s?.name ? `${s.name}_` : ''))
          .filter(Boolean);
        const attributionInput = {
          stableSystem: stableSystemContent,
          volatileSystem,
          messages: fullMessages.filter((m) => m.role !== 'system'),
          tools,
          ragContext: injectedRagContext,
        };
        const report = buildAttributionReport(attributionInput, { mcpPrefixes });
        // Exact-total calibration is opt-in (extra network call) via
        // DEBUG_CONTEXT_EXACT, since it hits the Anthropic count_tokens API.
        if (process.env.DEBUG_CONTEXT_EXACT === '1' || process.env.DEBUG_CONTEXT_EXACT === 'true') {
          report.exactTotal = await countTokensAnthropic(attributionInput, parseModelString(primary.modelString)?.modelId);
        }
        logger.info(
          {
            event: 'context_attribution',
            agentId,
            model: primary.modelString,
            ...report,
          },
          '[LLMExecutor] Context attribution',
        );
        console.log(`[LLMExecutor] Context attribution (agent=${agentId} model=${primary.modelString})` + formatAttributionTable(report));
      } catch (err) {
        console.warn('[LLMExecutor] Context attribution failed (non-fatal):', err);
      }
    }

    const tryGenerate = async (resolved: ResolvedModel): Promise<ChatResponse> => {
      let stepIndex = 0;
      const genStart = Date.now();

      const genArgs: Parameters<typeof generateText>[0] = {
        model: wrapModel(resolved.model),
        messages: fullMessages,
        temperature,
        // Explicit so retryable failures (429/529) are retried by the SDK on
        // the primary model before the executor hops to a fallback — see
        // classifyError() below.
        maxRetries: 2,
        ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
        ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
        ...toolOptions,
        onStepFinish: (step: StepView) => {
          const n = ++stepIndex;
          const stepTokens = step.usage
            ? ` | tokens in=${step.usage.inputTokens ?? '?'} out=${step.usage.outputTokens ?? '?'}`
            : '';
          console.log(`[LLMExecutor] ── Step ${n} | finishReason: ${step.finishReason}${stepTokens}`);

          if (step.toolCalls?.length) {
            for (const tc of step.toolCalls) {
              const inputSnippet = JSON.stringify(tc.input ?? {}).slice(0, 300);
              console.log(`[LLMExecutor]  → tool_call  : ${tc.toolName}  ${inputSnippet}`);
            }
          }

          if (step.toolResults?.length) {
            for (const tr of step.toolResults) {
              const outputSnippet = String(tr.output ?? '').slice(0, 300);
              console.log(`[LLMExecutor]  ← tool_result: ${tr.toolName}  ${outputSnippet}`);
            }
          }

          if (step.text) {
            console.log(`[LLMExecutor]  ✎ text: ${step.text.slice(0, 300)}`);
          }

          // step.reasoning is always Array<ReasoningPart> (never null/undefined),
          // so ?? never reaches step.reasoningText. Use reasoningText directly —
          // the SDK already joins all part.text values into a single string.
          const rawReasoning = step.reasoningText ?? undefined;
          // In progressive mode this is the final 'done' stage; it shares the
          // step's id with the earlier live stages so the thought stream replaces
          // the row in place. Off: classic random id (unchanged). Persisted once
          // either way.
          const stepId = progressiveSteps ? makeStepId('main', n) : undefined;
          emitStep({
            id: stepId ?? crypto.randomUUID(),
            stage: progressiveSteps ? 'done' : undefined,
            sessionId: chatId ?? 'web',
            timestamp: new Date().toISOString(),
            stepIndex: n,
            finishReason: step.finishReason,
            text: step.text || undefined,
            reasoning: normalizeReasoning(rawReasoning),
            toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
            toolResults: mapStepToolResults(step),
            ragContext: chatId ? consumeRagContext(chatId) : undefined,
            // Only store the system prompt on the first step to avoid duplication.
            systemPrompt: n === 1 ? systemContent : undefined,
            agentId,
            specialistId: specialistId ?? orchestrationRunId,
            turnId,
            phase: 'main',
            ...extractUsage(step.usage),
            model: resolved.modelString,
          });
        },
      };

      // Subset (progressive) vs full GenerateTextResult (classic) — downstream
      // reads .text/.steps/.usage, present on both; typed any to match the
      // file's existing result handling and satisfy ChatResponse.result.
      const result: GenerationResult = progressiveSteps
        ? await runStreamedGeneration(genArgs, {
            sessionId: chatId ?? 'web',
            agentId,
            specialistId: specialistId ?? orchestrationRunId,
            turnId,
            phase: 'main',
            model: resolved.modelString,
            makeStepId: (n) => makeStepId('main', n),
          })
        : await generateText(genArgs);

      const durationMs = Date.now() - genStart;
      const usage = result.usage;
      const tokensIn = usage?.inputTokens ?? '?';
      const tokensOut = usage?.outputTokens ?? '?';
      console.log(
        `[LLMExecutor] Done | steps=${stepIndex} duration=${durationMs}ms tokens in=${tokensIn} out=${tokensOut} model=${resolved.modelString}`,
      );

      // Detect max-steps cutoff: last step ended with tool-calls
      // This can happen with OR without final text - the model may have generated
      // text like "let me continue working on this..." but hit the step limit.
      // Also detect output-token limit (finishReason: length) and treat gracefully.
      const lastStep = result.steps[result.steps.length - 1];
      const hitMaxSteps = lastStep?.finishReason === 'tool-calls';
      const hitTokenLimit = lastStep?.finishReason === 'length';

      if (hitMaxSteps) {
        console.log(`[LLMExecutor] Max steps reached (${maxSteps}). Requesting summary from model.`);
        // Build a summary by asking the model to reflect on the steps taken so far
        const stepSummary = result.steps
          .flatMap((s) => [
            ...(s.toolCalls ?? []).map((tc) =>
              `- called ${tc.toolName}(${JSON.stringify(tc.input ?? {}).slice(0, 120)})`,
            ),
            ...(s.toolResults ?? []).map((tr) =>
              `- ${tr.toolName} returned: ${String(tr.output ?? '').slice(0, 200)}`,
            ),
            s.text ? `- said: ${s.text.slice(0, 200)}` : null,
          ])
          .filter(Boolean)
          .join('\n');

        // Constrained "summarize what happened" task — route to the cheaper
        // aux model unconditionally (see rec #9: auxiliary turns don't need
        // the full-price primary model).
        const summaryModel = resolveAuxModel(cfg.auxModel, resolved);
        const summaryResult = await generateText({
          model: wrapModel(summaryModel.model),
          messages: [
            ...fullMessages,
            {
              role: 'assistant' as const,
              content: `[I reached the maximum of ${maxSteps} steps and was cut off mid-task. Here is what I did so far:\n${stepSummary}]`,
            },
            {
              role: 'user' as const,
              content:
                'You were cut off after reaching the step limit. In 3-5 sentences, summarize: (1) what you accomplished, (2) where you stopped, and (3) what remains to be done. Be concise and specific.',
            },
          ],
          temperature: auxTemperature,
          maxRetries: 2,
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
        });
        const summary = `⚠️ Reached the ${maxSteps}-step limit mid-task.\n\n${maybeStrip(summaryResult.text)}`;
        // Even on max-steps, wait for any pending specialists before returning
        const finalSummary = await this.finalizeResponseWithSpecialists(summary, chatId, showThinking, turnJobIds, !!specialistId, agentId, originalRequest);
        return { type: 'text', text: finalSummary, result, provider: resolved.modelString, hitMaxSteps: true, maxStepsUsed: maxSteps, turnId, responseMessages: result.response?.messages };
      }

      if (hitTokenLimit) {
        // Output token limit hit — partial text was generated. Return what we have with a warning.
        console.log(`[LLMExecutor] Output token limit reached. Partial text length: ${result.text.length}`);
        const partialText = result.text || result.steps.map((s) => s.text).filter(Boolean).join('\n\n');
        const notice = `⚠️ Response truncated: the output token limit was reached. Consider increasing llm.maxTokens in config.yaml.\n\n${maybeStrip(partialText)}`;
        const finalNotice = await this.finalizeResponseWithSpecialists(notice, chatId, showThinking, turnJobIds, !!specialistId, agentId, originalRequest);
        return { type: 'text', text: finalNotice, result, provider: resolved.modelString, turnId, responseMessages: result.response?.messages };
      }

      // Background specialists await their children before returning; the main agent
      // returns immediately and lets background jobs complete independently.
      let cleanText = result.text;

      const finalisePrompt = agentConfig.finalisePrompt?.trim();
      if (finalisePrompt) {
        console.log(`[LLMExecutor] Running finalise turn for agent=${agentId}`);
        let finaliseStepIndex = 0;
        let amendedText: string | undefined;
        const finaliseTools = {
          ...(tools ?? {}),
          ...makeAmendTool((text: string) => { amendedText = text; }),
        };
        const finaliseToolOptions = {
          tools: finaliseTools,
          toolChoice: 'auto' as const,
          stopWhen: stepCountIs(maxSteps),
        };
        const frameworkNote =
          'Framework note: This is a finalise/verification turn. Your previous response — shown in the assistant turn immediately above — ' +
          'has ALREADY been delivered to the user as your reply; the framework delivers it automatically (e.g. over Telegram). ' +
          'You do NOT need to, and must NOT, send that response to the user yourself by any means ' +
          '(do not look up bot tokens, call messaging APIs, or use the terminal to deliver it — that would double-send).\n\n' +
          'Use tools to complete any outstanding work (writing reports, generating links, running checks). ' +
          'Your plain text in this turn is NOT shown to the user — it is internal trace only. ' +
          'If, and ONLY if, the already-delivered response above needs to change (e.g. to include a link you just generated, or to correct a factual error), ' +
          'call `amend_final_response(new_text)` with the full corrected response. Otherwise simply finish without calling it.\n\n' +
          '--- Agent finalise instructions ---\n' +
          finalisePrompt;
        // Finalise may do real tool work (writing reports, calling APIs), so
        // unlike the summary/todo-check turns it's configurable per-agent
        // rather than unconditionally routed to the aux model: agent's own
        // finaliseModel wins, then the global aux model, then the main model.
        const finaliseModel = resolveAuxModel(agentConfig.finaliseModel ?? cfg.auxModel, resolved);
        const finaliseArgs = {
          model: wrapModel(finaliseModel.model),
          messages: [
            ...fullMessages,
            { role: 'assistant' as const, content: result.text },
            { role: 'user' as const, content: frameworkNote },
          ],
          temperature: auxTemperature,
          maxRetries: 2,
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
          ...finaliseToolOptions,
          onStepFinish: (step: StepView) => {
            const n = ++finaliseStepIndex;
            console.log(`[LLMExecutor] ── Finalise Step ${n} | finishReason: ${step.finishReason}`);
            const rawReasoning = step.reasoningText ?? undefined;
            const stepId = progressiveSteps ? makeStepId('finalise', n) : undefined;
            emitStep({
              id: stepId ?? crypto.randomUUID(),
              stage: progressiveSteps ? 'done' : undefined,
              sessionId: chatId ?? 'web',
              timestamp: new Date().toISOString(),
              stepIndex: n,
              finishReason: step.finishReason,
              text: step.text || undefined,
              reasoning: normalizeReasoning(rawReasoning),
              toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
              toolResults: mapStepToolResults(step),
              ragContext: chatId ? consumeRagContext(chatId) : undefined,
              agentId,
              specialistId: specialistId ?? orchestrationRunId,
              turnId,
              phase: 'finalise',
              ...extractUsage(step.usage),
              model: finaliseModel.modelString,
            });
          },
        };

        if (progressiveSteps) {
          await runStreamedGeneration(finaliseArgs, {
            sessionId: chatId ?? 'web',
            agentId,
            specialistId: specialistId ?? orchestrationRunId,
            turnId,
            phase: 'finalise',
            model: finaliseModel.modelString,
            makeStepId: (n) => makeStepId('finalise', n),
          });
        } else {
          await generateText(finaliseArgs);
        }
        if (amendedText !== undefined) {
          console.log(`[LLMExecutor] Finalise turn amended the response (${amendedText.length} chars)`);
          cleanText = amendedText;
        }
      }

      // ── Todo check: if an incomplete todo list remains after the main turn (and
      // any finalise turn), give the agent one pass to continue or tidy up.
      // Not a hard requirement — doing nothing is valid. The response has not
      // been delivered yet; amend_final_response can update it if new results
      // are produced.
      //
      // NOTE: `chatId` is intentionally the *main-agent* todo scope. Specialists
      // are scoped separately (by their specialistId — see executeSpecialist), so
      // this load only ever sees the main agent's own list. Do not change this to
      // pick up specialist-written todos, or background specialists will leak
      // their lists into the main agent and get re-executed here.
      if (chatId && !effectiveAbortSignal?.aborted) {
        const pendingList = todoManager.load(chatId);
        const pendingItems = todoManager.pendingItems(pendingList);
        // Pending todos alongside active background jobs are the EXPECTED state
        // of the delegate-and-reply pattern, not dropped work: when the jobs
        // finish, the batch dispatcher schedules a synthesis turn that sees the
        // list (volatile prompt) and resumes it. Nudging the model here caused
        // it to "reconcile" the contradiction by disowning work it had actually
        // done (walking back a successful spawn as never having happened), so
        // the check is suppressed entirely while jobs are in flight.
        // getRunningJobsForChat covers 'pending' + 'running', which includes
        // jobs spawned this very turn (created as 'pending').
        const activeJobs = pendingItems.length > 0
          ? await getRunningJobsForChat(chatId).catch(() => [])
          : [];
        if (pendingItems.length > 0 && activeJobs.length > 0) {
          console.log(`[LLMExecutor] Skipping todo-check: ${pendingItems.length} pending item(s) with ${activeJobs.length} background job(s) in flight — synthesis turn will resume`);
        }
        if (pendingItems.length > 0 && activeJobs.length === 0) {
          console.log(`[LLMExecutor] Incomplete todo list (${pendingItems.length} item(s)) — running todo-check turn`);
          let todoCheckStepIndex = 0;
          let todoCheckAmendedText: string | undefined;
          const todoCheckTools = {
            ...makeAmendTool((text: string) => { todoCheckAmendedText = text; }),
          };
          const todoCheckNote =
            `Framework note (automated post-turn check, not a user message): your turn ended with ` +
            `${pendingItems.length} incomplete item(s) on your todo list:\n\n${todoManager.format(pendingList!)}\n\n` +
            `Facts, for grounding: no background specialist jobs are currently running for this conversation, ` +
            `so nothing will resume these items automatically. Every tool call shown in the conversation above ` +
            `did happen — do not claim work failed, or was not done, unless the conversation shows that.\n\n` +
            `An incomplete list can be perfectly fine (items intentionally deferred, a question posed to the user, ` +
            `work correctly handed off). If your response above already reflects the true state of the work, ` +
            `do nothing — finish without calling any tool, and the response is delivered as-is.\n\n` +
            `Only if the response is inaccurate or would mislead the user about what was and wasn't done, ` +
            `call \`amend_final_response\` with the full corrected response: (1) what was completed, ` +
            `(2) what remains, (3) how the user can continue. Do NOT attempt to continue the work here — ` +
            `there is not enough budget — and do not use any other tools.`;
          // Constrained "write a status update via one tool call" task — route
          // to the cheaper aux model unconditionally, and trim context to just
          // what it needs: the system prompt, the last user message (for
          // grounding), the draft response, and the todo-check note (which
          // already embeds the full todo list). Full turn history isn't
          // needed here — this is the single biggest context saving of the
          // three auxiliary turns.
          const todoCheckModel = resolveAuxModel(cfg.auxModel, resolved);
          const lastUserMessage = [...fullMessages].reverse().find((m) => m.role === 'user');
          const todoCheckArgs = {
            model: wrapModel(todoCheckModel.model),
            messages: [
              fullMessages[0],
              fullMessages[1],
              ...(lastUserMessage ? [lastUserMessage] : []),
              { role: 'assistant' as const, content: cleanText },
              { role: 'user' as const, content: todoCheckNote },
            ],
            temperature: auxTemperature,
            maxRetries: 2,
            ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
            ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
            tools: todoCheckTools,
            toolChoice: 'auto' as const,
            stopWhen: stepCountIs(3),
            onStepFinish: (step: StepView) => {
              const n = ++todoCheckStepIndex;
              console.log(`[LLMExecutor] ── Todo-Check Step ${n} | finishReason: ${step.finishReason}`);
              const rawReasoning = step.reasoningText ?? undefined;
              const stepId = progressiveSteps ? makeStepId('todo-check', n) : undefined;
              emitStep({
                id: stepId ?? crypto.randomUUID(),
                stage: progressiveSteps ? 'done' : undefined,
                sessionId: chatId ?? 'web',
                timestamp: new Date().toISOString(),
                stepIndex: n,
                finishReason: step.finishReason,
                text: step.text || undefined,
                reasoning: normalizeReasoning(rawReasoning),
                toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
                toolResults: mapStepToolResults(step),
                ragContext: chatId ? consumeRagContext(chatId) : undefined,
                agentId,
                specialistId: specialistId ?? orchestrationRunId,
                turnId,
                phase: 'todo-check',
                ...extractUsage(step.usage),
                model: todoCheckModel.modelString,
              });
            },
          };
          if (progressiveSteps) {
            await runStreamedGeneration(todoCheckArgs, {
              sessionId: chatId ?? 'web',
              agentId,
              specialistId: specialistId ?? orchestrationRunId,
              turnId,
              phase: 'todo-check',
              model: todoCheckModel.modelString,
              makeStepId: (n) => makeStepId('todo-check', n),
            });
          } else {
            await generateText(todoCheckArgs);
          }
          if (todoCheckAmendedText !== undefined) {
            console.log(`[LLMExecutor] Todo-check turn amended the response (${todoCheckAmendedText.length} chars)`);
            cleanText = todoCheckAmendedText;
          }
        }
      }

      const finalText = await this.finalizeResponseWithSpecialists(cleanText, chatId, showThinking, turnJobIds, !!specialistId, agentId, originalRequest);
      return { type: 'text', text: finalText, result, provider: resolved.modelString, turnId, responseMessages: result.response?.messages };
    };

    const errors: string[] = [];
    // Providers whose remaining fallback entries should be skipped after a
    // provably deterministic (non-retryable) failure from that provider.
    const skipProviders = new Set<string>();

    try {
      try {
        return await tryGenerate(primary);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const { message, tag, skipSameProvider } = classifyError(error);
        errors.push(`${primary.modelString}: ${message}${tag ? ` (${tag})` : ''}`);
        console.error(`[LLMExecutor] Model ${primary.modelString} failed:`, message);
        if (skipSameProvider) {
          const provider = parseModelString(primary.modelString)?.provider;
          if (provider) skipProviders.add(provider);
        }
      }

      for (const fallback of fallbacks) {
        const fallbackProvider = parseModelString(fallback.modelString)?.provider;
        if (fallbackProvider && skipProviders.has(fallbackProvider)) {
          errors.push(`${fallback.modelString}: skipped (same provider as a non-retryable failure above)`);
          console.log(`[LLMExecutor] Skipping fallback ${fallback.modelString} — same provider as a non-retryable failure`);
          continue;
        }
        try {
          console.log(`[LLMExecutor] Trying fallback: ${fallback.modelString}...`);
          return await tryGenerate(fallback);
        } catch (fallbackError) {
          if (fallbackError instanceof Error && fallbackError.name === 'AbortError') throw fallbackError;
          const { message, tag, skipSameProvider } = classifyError(fallbackError);
          errors.push(`${fallback.modelString}: ${message}${tag ? ` (${tag})` : ''}`);
          console.error(`[LLMExecutor] Fallback ${fallback.modelString} failed:`, message);
          if (skipSameProvider && fallbackProvider) skipProviders.add(fallbackProvider);
        }
      }

      const allFailed = `[LLM] All models failed:\n${errors.map(e => `  - ${e}`).join('\n')}`;
      // Persist an error step so the turn is explained in review rather than
      // silently producing no reply.
      emitStep({
        id: crypto.randomUUID(),
        sessionId: chatId ?? 'web',
        timestamp: new Date().toISOString(),
        stepIndex: 0,
        finishReason: 'error',
        agentId,
        specialistId: specialistId ?? orchestrationRunId,
        turnId,
        phase: 'main',
        errorMessage: allFailed,
      });
      throw new Error(allFailed);
    } finally {
      if (ownController && specialistId) {
        cancellationRegistry.unregister(specialistId);
      }
    }
  }
}

export const llmExecutor = new LLMExecutor();
