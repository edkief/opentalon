import { generateText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { agentRegistry } from '../soul';
import { configManager } from '../config';
import { memoryManager } from './memory-manager';
import { wrapModelWithMemory, wrapModelWithToolCompression } from './middleware';
import type { Message, ChatOptions, ChatResponse, ExecutorConfig } from './types';
import { emitStep } from './log-bus';
import { consumeRagContext } from './rag-store';
import { resolveModelList } from './model-resolver';
import type { ResolvedModel } from './model-resolver';
import { todoManager } from './todo-manager';
import { listSkills } from '../tools';
import { db } from '../db';
import { workflows as workflowsTable } from '../db/schema';
import { ne, inArray } from 'drizzle-orm';
import { cancellationRegistry } from './cancellation';
import { getJobsByChatId, updateJobStatus } from '../db/jobs';

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
  if (typeof rawReasoning === 'string') {
    return rawReasoning.trim() || undefined;
  }
  if (typeof rawReasoning === 'object') {
    if (Array.isArray(rawReasoning)) {
      return rawReasoning
        .map((item) => {
          if (item != null && typeof item === 'object') {
            const r = item as Record<string, unknown>;
            if (typeof r.text === 'string') return r.text.trim();
            if (typeof r.content === 'string') return r.content.trim();
            if (typeof r.value === 'string') return r.value.trim();
            if (r.type === 'redacted') return '';
            return JSON.stringify(r);
          }
          return String(item).trim();
        })
        .filter(Boolean)
        .join('\n');
    }
    const reasoningObject = rawReasoning as Record<string, unknown>;
    if (typeof reasoningObject.text === 'string') {
      return reasoningObject.text.trim() || undefined;
    }
    if (typeof reasoningObject.content === 'string') {
      return reasoningObject.content.trim() || undefined;
    }
    if (typeof reasoningObject.value === 'string') {
      return reasoningObject.value.trim() || undefined;
    }
    return JSON.stringify(reasoningObject, null, 2);
  }
  return String(rawReasoning).trim() || undefined;
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
   */
  private async finalizeResponseWithSpecialists(
    baseText: string,
    chatId?: string,
    showThinking = false,
  ): Promise<string> {
    if (!chatId) return showThinking ? baseText : stripThinkingTokens(baseText);

    const specialistResults = await this.awaitPendingSpecialists(chatId);
    const stripped = showThinking ? baseText : stripThinkingTokens(baseText);
    return stripped + specialistResults;
  }

  /**
   * Wait for any background specialists spawned by this agent (chatId) to complete
   * before generating the final response. This ensures consolidated output instead
   * of fragmented responses.
   *
   * @param chatId - The chat session ID to wait for
   * @param maxWaitMs - Maximum time to wait (default 120 seconds)
   * @returns The consolidated specialist results text, or empty string if none completed
   */
  private async awaitPendingSpecialists(chatId: string, maxWaitMs = 120_000): Promise<string> {
    const startTime = Date.now();
    const checkInterval = 2_000; // Check every 2 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const runningJobs = await getJobsByChatId(chatId, 50);
      const pendingOrRunning = runningJobs.filter(
        (job) => job.status === 'pending' || job.status === 'running',
      );

      // No pending specialists — all have completed (or failed)
      if (pendingOrRunning.length === 0) {
        const completedJobs = runningJobs.filter(
          (job) => job.status === 'completed' || job.status === 'max_steps_reached',
        );

        if (completedJobs.length > 0) {
          // Build consolidated results from all completed specialists
          const results = completedJobs
            .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
            .map((job) => {
              const taskLabel = job.taskDescription?.split('\n')[0]?.slice(0, 80) ?? 'Task';
              const resultText = job.result ?? '';
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

    // Timeout — just return what we have
    console.log(`[LLMExecutor] awaitPendingSpecialists timed out after ${maxWaitMs}ms`);
    return '';
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Fail-safe: refuse to process if config has a syntax error
    if (!configManager.isValid()) {
      throw new Error(`[Config] Invalid configuration: ${configManager.error}`);
    }

    const cfg = configManager.get().llm ?? {};
    const { messages, context = '', memoryScope, chatId, tools, agentId = 'default', modelOverride, specialistId, abortSignal } = options;
    const maxSteps = options.maxSteps ?? cfg.maxSteps ?? 10;
    const maxTokens = this.config.maxTokens ?? cfg.maxTokens ?? undefined;
    const showThinking = cfg.showThinking === true;
    const maybeStrip = (text: string) => (showThinking ? text : stripThinkingTokens(text));

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
    const fullMessages: Message[] = [
      ...(additionalInstructions
        ? [{ role: 'system' as const, content: `## Framework Instructions\n$systemPrompt\n\n## Additional Instructions\n${additionalInstructions}` }]
        : []),
      ...messages,
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

      const result = await generateText({
        model: wrapModel(resolved.model),
        messages: fullMessages as any,
        temperature,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(effectiveAbortSignal !== undefined ? { abortSignal: effectiveAbortSignal } : {}),
        ...toolOptions,
        onStepFinish: (step: any) => {
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

          const rawReasoning = step.reasoning ?? step.reasoningText ?? undefined;
          emitStep({
            id: crypto.randomUUID(),
            sessionId: chatId ?? 'web',
            timestamp: new Date().toISOString(),
            stepIndex: n,
            finishReason: step.finishReason,
            text: step.text || undefined,
            reasoning: normalizeReasoning(rawReasoning),
            toolCalls: step.toolCalls?.map((tc: any) => ({ toolName: tc.toolName, input: tc.input ?? tc.args })),
            toolResults: step.toolResults?.map((tr: any) => ({
              toolName: tr.toolName,
              output:
                tr.toolName === 'request_secret'
                  ? '[secret request initiated — url redacted from logs]'
                  : String(tr.output ?? tr.result ?? '').slice(0, 10_000),
            })),
            ragContext: chatId ? consumeRagContext(chatId) : undefined,
            agentId: agentRegistry.isDefaultAgent(agentId) ? undefined : agentId,
            specialistId,
          });
        },
      });

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
          .flatMap((s: any) => [
            ...(s.toolCalls ?? []).map((tc: any) =>
              `- called ${tc.toolName}(${JSON.stringify(tc.input ?? tc.args ?? {}).slice(0, 120)})`,
            ),
            ...(s.toolResults ?? []).map((tr: any) =>
              `- ${tr.toolName} returned: ${String(tr.output ?? tr.result ?? '').slice(0, 200)}`,
            ),
            s.text ? `- said: ${s.text.slice(0, 200)}` : null,
          ])
          .filter(Boolean)
          .join('\n');

        const summaryResult = await generateText({
          model: wrapModel(resolved.model),
          system: systemPrompt,
          messages: [
            ...fullMessages as any,
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
        const finalSummary = await this.finalizeResponseWithSpecialists(summary, chatId, showThinking);
        return { type: 'text', text: finalSummary, result, provider: resolved.modelString, hitMaxSteps: true, maxStepsUsed: maxSteps };
      }

      if (hitTokenLimit) {
        // Output token limit hit — partial text was generated. Return what we have with a warning.
        console.log(`[LLMExecutor] Output token limit reached. Partial text length: ${result.text.length}`);
        const partialText = result.text || result.steps.map((s: any) => s.text).filter(Boolean).join('\n\n');
        const notice = `⚠️ Response truncated: the output token limit was reached. Consider increasing llm.maxTokens in config.yaml.\n\n${maybeStrip(partialText)}`;
        const finalNotice = await this.finalizeResponseWithSpecialists(notice, chatId, showThinking);
        return { type: 'text', text: finalNotice, result, provider: resolved.modelString };
      }

      // Before returning the final response, wait for any pending background specialists
      // to complete so we can include their results in a consolidated response.
      const finalText = await this.finalizeResponseWithSpecialists(result.text, chatId, showThinking);
      return { type: 'text', text: finalText, result, provider: resolved.modelString };
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

      throw new Error(`[LLM] All models failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    } finally {
      if (ownController && specialistId) {
        cancellationRegistry.unregister(specialistId);
      }
    }
  }
}

export const llmExecutor = new LLMExecutor();
