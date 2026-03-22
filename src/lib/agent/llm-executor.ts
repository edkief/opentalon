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
- **never assume** a job or schedule already exists, even if you have an id in chat history. Verify and confirm by looking at their respective queues.`)

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

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Fail-safe: refuse to process if config has a syntax error
    if (!configManager.isValid()) {
      throw new Error(`[Config] Invalid configuration: ${configManager.error}`);
    }

    const cfg = configManager.get().llm ?? {};
    const { messages, context = '', memoryScope, chatId, tools, agentId = 'default', modelOverride } = options;
    const maxSteps = options.maxSteps ?? cfg.maxSteps ?? 10;
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
    console.log(`[LLMExecutor] Using model: ${primary.modelString}, agent: ${agentId}`);
    if (fallbacks.length) console.log(`[LLMExecutor] Fallbacks: ${fallbacks.map(m => m.modelString).join(', ')}`);

    const systemPrompt = await this.getSystemPrompt(context, agentId, chatId);
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

      const result = await generateText({
        model: wrapModel(resolved.model),
        messages: fullMessages as any,
        temperature,
        ...toolOptions,
        onStepFinish: (step: any) => {
          const n = ++stepIndex;
          console.log(`[LLMExecutor] ── Step ${n} | finishReason: ${step.finishReason}`);

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
            agentId: agentId !== 'default' ? agentId : undefined,
          });
        },
      });

      console.log(`[LLMExecutor] Done after ${stepIndex} step(s). Final text length: ${result.text.length}`);

      // Detect max-steps cutoff: last step ended with tool-calls
      // This can happen with OR without final text - the model may have generated
      // text like "let me continue working on this..." but hit the step limit
      const lastStep = result.steps[result.steps.length - 1];
      const hitMaxSteps = lastStep?.finishReason === 'tool-calls';

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
