import { generateText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { agentRegistry } from '../soul';
import { configManager } from '../config';
import { memoryManager } from './memory-manager';
import { wrapModelWithMemory } from './middleware';
import type { Message, ChatOptions, ChatResponse, ExecutorConfig } from './types';
import { emitStep } from './log-bus';
import { consumeRagContext } from './rag-store';
import { resolveModelList } from './model-resolver';
import type { ResolvedModel } from './model-resolver';
import { todoManager } from './todo-manager';

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

export class LLMExecutor {
  private config: ExecutorConfig;

  constructor(config: ExecutorConfig = {}) {
    this.config = config;
  }

  private async getSystemPrompt(context: string = '', agentId: string = 'default', chatId?: string): Promise<string> {
    const sm = agentRegistry.getSoulManager(agentId);
    const agentConfig = sm.getConfig();
    const soulContent = sm.getContent();
    const identityContent = sm.getIdentityContent();

    const memoryContent = memoryManager.getContent();

    const parts: string[] = [];
    if (identityContent) parts.push(`## Identity\n${identityContent}`);
    parts.push(`## Soul\n${soulContent}`);
    if (memoryContent) parts.push(`\n\n## Core Memory\n${memoryContent}`);
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

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Fail-safe: refuse to process if config has a syntax error
    if (!configManager.isValid()) {
      throw new Error(`[Config] Invalid configuration: ${configManager.error}`);
    }

    const cfg = configManager.get().llm ?? {};
    const { messages, context = '', memoryScope, chatId, tools, agentId = 'default', modelOverride, specialistId } = options;
    const maxSteps = options.maxSteps ?? cfg.maxSteps ?? 10;
    const maxTokens = this.config.maxTokens ?? cfg.maxTokens ?? undefined;
    const showThinking = cfg.showThinking === true;
    const maybeStrip = (text: string) => (showThinking ? text : stripThinkingTokens(text));

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

    const fullMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const wrapModel = (model: LanguageModel): LanguageModel =>
      enableMemory && memoryScope && chatId && agentRagEnabled
        ? wrapModelWithMemory(model, memoryScope, chatId, agentId)
        : model;

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

          emitStep({
            id: crypto.randomUUID(),
            sessionId: chatId ?? 'web',
            timestamp: new Date().toISOString(),
            stepIndex: n,
            finishReason: step.finishReason,
            text: step.text || undefined,
            toolCalls: step.toolCalls?.map((tc: any) => ({ toolName: tc.toolName, input: tc.input ?? tc.args })),
            toolResults: step.toolResults?.map((tr: any) => ({
              toolName: tr.toolName,
              output:
                tr.toolName === 'request_secret'
                  ? '[secret request initiated — url redacted from logs]'
                  : String(tr.output ?? tr.result ?? '').slice(0, 500),
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
        return { type: 'text', text: summary, result, provider: resolved.modelString, hitMaxSteps: true, maxStepsUsed: maxSteps };
      }

      if (hitTokenLimit) {
        // Output token limit hit — partial text was generated. Return what we have with a warning.
        console.log(`[LLMExecutor] Output token limit reached. Partial text length: ${result.text.length}`);
        const partialText = result.text || result.steps.map((s: any) => s.text).filter(Boolean).join('\n\n');
        const notice = `⚠️ Response truncated: the output token limit was reached. Consider increasing llm.maxTokens in config.yaml.\n\n${maybeStrip(partialText)}`;
        return { type: 'text', text: notice, result, provider: resolved.modelString };
      }

      return { type: 'text', text: maybeStrip(result.text), result, provider: resolved.modelString };
    };

    const errors: string[] = [];

    try {
      return await tryGenerate(primary);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${primary.modelString}: ${msg}`);
      console.error(`[LLMExecutor] Model ${primary.modelString} failed:`, msg);
    }

    for (const fallback of fallbacks) {
      try {
        console.log(`[LLMExecutor] Trying fallback: ${fallback.modelString}...`);
        return await tryGenerate(fallback);
      } catch (fallbackError) {
        const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        errors.push(`${fallback.modelString}: ${msg}`);
        console.error(`[LLMExecutor] Fallback ${fallback.modelString} failed:`, msg);
      }
    }

    throw new Error(`[LLM] All models failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

export const llmExecutor = new LLMExecutor();
