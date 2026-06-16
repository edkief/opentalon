import { generateText, stepCountIs } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { agentRegistry } from '../soul';
import { configManager } from '../config';
import { memoryManager } from './memory-manager';
import { wrapModelWithMemory, wrapModelWithToolCompression } from './middleware';
import type { Message, ChatOptions, ChatResponse, ExecutorConfig, StepView, GenerationResult } from './types';
import { emitStep, mapStepToolResults } from './log-bus';
import { runStreamedGeneration } from './streamed-step';
import { consumeRagContext } from './rag-store';
import { resolveModelList } from './model-resolver';
import type { ResolvedModel } from './model-resolver';
import { todoManager } from './todo-manager';
import { listSkills } from '../tools';
import { db } from '../db';
import { workflows as workflowsTable } from '../db/schema';
import { ne, inArray } from 'drizzle-orm';
import { cancellationRegistry } from './cancellation';
import { getJobById } from '../db/jobs';
import { makeAmendTool } from '../tools/finalise';
import { registerSpecialistBatch } from './specialist-batch';

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
    .trim();
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

  async getSystemPrompt(context: string = '', agentId: string = 'default', chatId?: string): Promise<string> {
    const sm = agentRegistry.getSoulManager(agentId);
    const agentConfig = sm.getConfig();
    const soulContent = sm.getContent();
    const identityContent = sm.getIdentityContent();

    const memoryContent = memoryManager.getContent();

    const timezone = configManager.get().timezone ?? 'UTC';
    const now = new Date();
    const localDatetime = now.toLocaleString('en-AU', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });

    const parts: string[] = [];
    if (identityContent) parts.push(`## Identity\n${identityContent}`);
    parts.push(`## Soul\n${soulContent}`);
    if (memoryContent) parts.push(`\n\n## Core Memory\n${memoryContent}`);
    parts.push(`\n\n## Current date & time\n${localDatetime} (${timezone})`);
    if (context) parts.push(`\n\nContext: ${context}`);
    const todoSummary = chatId ? todoManager.getSummary(chatId) : '';
    if (todoSummary) parts.push(`
## Active Todos
${todoSummary}`);
    parts.push(`

## Task execution
For quick tasks (single tool call, simple questions), respond directly. For multi-step or long-running tasks, prefer spawning a background specialist via spawn_specialist with background: true and immediately reply with a brief acknowledgement — this frees you to handle new messages while the task runs. For multi-step tasks you handle directly, use todo_create to set a goal and task list before starting work, then call todo_update to mark items done as you progress.`);
    parts.push(`

## Spawning Specialists Agents and Scheduling Tasks
- You can spawn specialist agents to delegate work using the spawn_specialist tool and schedule tasks using the schedule_task tool
- **never assume** a job or schedule already exists, even if you have an id in chat history. Verify and confirm by looking at their respective queues.`);

    if (agentConfig.injectAvailableAgents) {
      const allAgents = agentRegistry.listAgents().filter(a => a.id !== agentId);
      if (allAgents.length > 0) {
        const agentLines = allAgents
          .map(a => `- **${a.id}**${a.description ? `: ${a.description}` : ''}`)
          .join('\n');
        parts.push(`\n\n## Available Agents\nYou can delegate tasks to the following agents using the spawn_specialist tool with the agent_id parameter:\n${agentLines}`);
      }
    }

    if (agentConfig.injectSkills) {
      let skills = await listSkills();
      if (Array.isArray(agentConfig.allowedSkills)) {
        skills = skills.filter(s => (agentConfig.allowedSkills as string[]).includes(s.name));
      }
      if (skills.length > 0) {
        const skillLines = skills.map(s => `- **${s.name}**: ${s.description}`).join('\n');
        parts.push(`\n\n## Available Skills\nUse skill_get to load a skill's instructions before executing it:\n${skillLines}`);
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
        parts.push(`\n\n## Available Workflows\nUse workflow_run to trigger a workflow by id:\n${wfLines}`);
      }
    }

    parts.push(`

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

**Do not use \`apt-get\`** to install tools — apt writes to the container's ephemeral layer and is lost on pod restart. If a package truly requires apt, request it be added to the base image.`);

    return parts.join('');
  }

  private getTemperature(agentId: string = 'default'): number {
    const sm = agentRegistry.getSoulManager(agentId);
    return (
      this.config.temperature ??
      configManager.get().llm?.temperature ??
      sm.getConfig().temperature ??
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
   * Only waits for the job IDs in turnJobIds — never picks up jobs from previous turns.
   */
  private async awaitPendingSpecialists(turnJobIds: Set<string>, maxWaitMs = 120_000): Promise<string> {
    const startTime = Date.now();
    const checkInterval = 2_000;
    const ids = [...turnJobIds];

    while (Date.now() - startTime < maxWaitMs) {
      const jobs = await Promise.all(ids.map((id) => getJobById(id)));
      const validJobs = jobs.filter(Boolean) as Awaited<ReturnType<typeof getJobById>>[];

      const pendingOrRunning = validJobs.filter(
        (job) => job!.status === 'pending' || job!.status === 'running',
      );

      if (pendingOrRunning.length === 0) {
        const completedJobs = validJobs.filter(
          (job) => job!.status === 'completed' || job!.status === 'max_steps_reached',
        );

        if (completedJobs.length > 0) {
          const results = completedJobs
            .sort((a, b) => (a!.createdAt?.getTime() ?? 0) - (b!.createdAt?.getTime() ?? 0))
            .map((job) => {
              const taskLabel = job!.taskDescription?.split('\n')[0]?.slice(0, 80) ?? 'Task';
              const resultText = job!.result ?? '';
              const truncated = resultText.length > 3000 ? resultText.slice(0, 3000) + '...' : resultText;
              return `[${taskLabel}]\n${truncated}`;
            })
            .join('\n\n');

          return `\n\n## Specialist Results\n\n${results}`;
        }
        return '';
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    console.log(`[LLMExecutor] awaitPendingSpecialists timed out after ${maxWaitMs}ms`);
    return '';
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Fail-safe: refuse to process if config has a syntax error
    if (!configManager.isValid()) {
      throw new Error(`[Config] Invalid configuration: ${configManager.error}`);
    }

    const cfg = configManager.get().llm ?? {};
    const { messages, context = '', memoryScope, chatId, tools, agentId = 'default', modelOverride, specialistId, orchestrationRunId, abortSignal, turnJobIds } = options;
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

    const baseSystemPrompt = await this.getSystemPrompt(context, agentId, chatId);
    // Append fork-and-wait guidance when running as a background specialist with sub-agent tools
    const systemPrompt = specialistId && tools && 'spawn_specialist' in tools
      ? baseSystemPrompt + this.getForkAndWaitGuidance()
      : baseSystemPrompt;
    const temperature = this.getTemperature(agentId);
    const enableMemory = this.isMemoryEnabled();
    const agentRagEnabled = agentConfig.ragEnabled ?? true; // default: RAG enabled

    const additionalInstructions = agentConfig.additionalInstructions?.trim();
    const systemContent = additionalInstructions
      ? `## Framework Instructions\n${systemPrompt}\n\n## Additional Instructions\n${additionalInstructions}`
      : systemPrompt;
    const toModelMessage = (m: Message): ModelMessage => {
      switch (m.role) {
        case 'system': return { role: 'system', content: m.content };
        case 'assistant': return { role: 'assistant', content: m.content };
        case 'user': return { role: 'user', content: m.content };
      }
    };
    const fullMessages: ModelMessage[] = [
      { role: 'system', content: systemContent },
      ...messages.map(toModelMessage),
    ];

    const wrapModel = (model: LanguageModel): LanguageModel => {
      let m = wrapModelWithToolCompression(model);
      if (enableMemory && memoryScope && chatId && agentRagEnabled) {
        m = wrapModelWithMemory(m, memoryScope, chatId, agentId);
      }
      return m;
    };

    const toolOptions = tools && Object.keys(tools).length > 0
      ? { tools, toolChoice: 'auto' as const, stopWhen: stepCountIs(maxSteps) }
      : {};

    const tryGenerate = async (resolved: ResolvedModel): Promise<ChatResponse> => {
      let stepIndex = 0;
      const genStart = Date.now();

      const genArgs = {
        model: wrapModel(resolved.model),
        messages: fullMessages,
        temperature,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
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
              const inputSnippet = JSON.stringify(tc.input ?? tc.args ?? {}).slice(0, 300);
              console.log(`[LLMExecutor]  → tool_call  : ${tc.toolName}  ${inputSnippet}`);
            }
          }

          if (step.toolResults?.length) {
            for (const tr of step.toolResults) {
              const outputSnippet = String(tr.output ?? tr.result ?? '').slice(0, 300);
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
            toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input ?? tc.args })),
            toolResults: mapStepToolResults(step),
            ragContext: chatId ? consumeRagContext(chatId) : undefined,
            // Only store the system prompt on the first step to avoid duplication.
            systemPrompt: n === 1 ? systemContent : undefined,
            agentId,
            specialistId: specialistId ?? orchestrationRunId,
            turnId,
            phase: 'main',
            inputTokens: step.usage?.inputTokens,
            outputTokens: step.usage?.outputTokens,
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
              `- called ${tc.toolName}(${JSON.stringify(tc.input ?? tc.args ?? {}).slice(0, 120)})`,
            ),
            ...(s.toolResults ?? []).map((tr) =>
              `- ${tr.toolName} returned: ${String(tr.output ?? tr.result ?? '').slice(0, 200)}`,
            ),
            s.text ? `- said: ${s.text.slice(0, 200)}` : null,
          ])
          .filter(Boolean)
          .join('\n');

        const summaryResult = await generateText({
          model: wrapModel(resolved.model),
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
          temperature,
        });
        const summary = `⚠️ Reached the ${maxSteps}-step limit mid-task.\n\n${maybeStrip(summaryResult.text)}`;
        // Even on max-steps, wait for any pending specialists before returning
        const finalSummary = await this.finalizeResponseWithSpecialists(summary, chatId, showThinking, turnJobIds, !!specialistId, agentId, originalRequest);
        return { type: 'text', text: finalSummary, result, provider: resolved.modelString, hitMaxSteps: true, maxStepsUsed: maxSteps, turnId };
      }

      if (hitTokenLimit) {
        // Output token limit hit — partial text was generated. Return what we have with a warning.
        console.log(`[LLMExecutor] Output token limit reached. Partial text length: ${result.text.length}`);
        const partialText = result.text || result.steps.map((s) => s.text).filter(Boolean).join('\n\n');
        const notice = `⚠️ Response truncated: the output token limit was reached. Consider increasing llm.maxTokens in config.yaml.\n\n${maybeStrip(partialText)}`;
        const finalNotice = await this.finalizeResponseWithSpecialists(notice, chatId, showThinking, turnJobIds, !!specialistId, agentId, originalRequest);
        return { type: 'text', text: finalNotice, result, provider: resolved.modelString, turnId };
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
        const finaliseArgs = {
          model: wrapModel(resolved.model),
          messages: [
            ...fullMessages,
            { role: 'assistant' as const, content: result.text },
            { role: 'user' as const, content: frameworkNote },
          ],
          temperature,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
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
              toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input ?? tc.args })),
              toolResults: mapStepToolResults(step),
              ragContext: chatId ? consumeRagContext(chatId) : undefined,
              agentId,
              specialistId: specialistId ?? orchestrationRunId,
              turnId,
              phase: 'finalise',
              inputTokens: step.usage?.inputTokens,
              outputTokens: step.usage?.outputTokens,
              model: resolved.modelString,
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
            model: resolved.modelString,
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
      if (chatId) {
        const pendingList = todoManager.load(chatId);
        const pendingItems = pendingList?.todos.filter((t) => !t.done) ?? [];
        if (pendingItems.length > 0) {
          console.log(`[LLMExecutor] Incomplete todo list (${pendingItems.length} item(s)) — running todo-check turn`);
          let todoCheckStepIndex = 0;
          let todoCheckAmendedText: string | undefined;
          const todoCheckTools = {
            ...(tools ?? {}),
            ...makeAmendTool((text: string) => { todoCheckAmendedText = text; }),
          };
          const todoCheckNote =
            `Framework note: You stopped responding but your todo list still has ` +
            `${pendingItems.length} incomplete item(s):\n\n${todoManager.format(pendingList!)}\n\n` +
            `If you have more work to do, use your tools to continue now — your response above has NOT ` +
            `been delivered to the user yet. If you complete further work and want to update or extend ` +
            `the response with new results, call \`amend_final_response\` with the full updated text. ` +
            `If the remaining items are no longer required (delegated, waiting for user, or task complete), ` +
            `call \`todo_clear\` or mark them done with \`todo_update\`. Doing nothing is also fine — ` +
            `stopping here is acceptable if the task is complete from the user's perspective.\n\n` +
            `Any plain text you write in this turn is internal trace only and NOT shown to the user ` +
            `unless you call \`amend_final_response\`.`;
          const todoCheckArgs = {
            model: wrapModel(resolved.model),
            messages: [
              ...fullMessages,
              { role: 'assistant' as const, content: cleanText },
              { role: 'user' as const, content: todoCheckNote },
            ],
            temperature,
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
            tools: todoCheckTools,
            toolChoice: 'auto' as const,
            stopWhen: stepCountIs(maxSteps),
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
                toolCalls: step.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: tc.input ?? tc.args })),
                toolResults: mapStepToolResults(step),
                ragContext: chatId ? consumeRagContext(chatId) : undefined,
                agentId,
                specialistId: specialistId ?? orchestrationRunId,
                turnId,
                phase: 'todo-check',
                inputTokens: step.usage?.inputTokens,
                outputTokens: step.usage?.outputTokens,
                model: resolved.modelString,
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
              model: resolved.modelString,
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
      return { type: 'text', text: finalText, result, provider: resolved.modelString, turnId };
    };

    const errors: string[] = [];

    try {
      try {
        return await tryGenerate(primary);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${primary.modelString}: ${msg}`);
        console.error(`[LLMExecutor] Model ${primary.modelString} failed:`, msg);
      }

      for (const fallback of fallbacks) {
        try {
          console.log(`[LLMExecutor] Trying fallback: ${fallback.modelString}...`);
          return await tryGenerate(fallback);
        } catch (fallbackError) {
          if (fallbackError instanceof Error && fallbackError.name === 'AbortError') throw fallbackError;
          const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          errors.push(`${fallback.modelString}: ${msg}`);
          console.error(`[LLMExecutor] Fallback ${fallback.modelString} failed:`, msg);
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
