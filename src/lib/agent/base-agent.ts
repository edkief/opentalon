import { generateText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { personaRegistry } from '../soul';
import { configManager } from '../config';
import { memoryManager } from './memory-manager';
import { wrapModelWithMemory } from './middleware';
import type { Message, ChatOptions, ChatResponse, AgentConfig } from './types';
import { emitStep } from './log-bus';
import { consumeRagContext } from './rag-store';
import { resolveModelList } from './model-resolver';
import type { ResolvedModel } from './model-resolver';

export class BaseAgent {
  private config: AgentConfig;

  constructor(config: AgentConfig = {}) {
    this.config = config;
  }

  private async getSystemPrompt(context: string = '', personaId: string = 'default'): Promise<string> {
    const sm = personaRegistry.getSoulManager(personaId);
    const soulContent = sm.getContent();
    const identityContent = sm.getIdentityContent();

    const memoryContent = memoryManager.getContent();

    const parts: string[] = [];
    if (identityContent) parts.push(`## Identity\n${identityContent}`);
    parts.push(`## Soul\n${soulContent}`);
    if (memoryContent) parts.push(`\n\n## Core Memory\n${memoryContent}`);
    if (context) parts.push(`\n\nContext: ${context}`);

    return parts.join('');
  }

  private getTemperature(personaId: string = 'default'): number {
    const sm = personaRegistry.getSoulManager(personaId);
    return (
      this.config.temperature ??
      configManager.get().llm?.temperature ??
      sm.getConfig().temperature ??
      0.7
    );
  }

  private isMemoryEnabled(): boolean {
    return (
      (configManager.get().memory?.enabled ?? process.env.ENABLE_MEMORY !== 'false')
    );
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    // Fail-safe: refuse to process if config has a syntax error
    if (!configManager.isValid()) {
      throw new Error(`[Config] Invalid configuration: ${configManager.error}`);
    }

    const cfg = configManager.get().llm ?? {};
    const { messages, context = '', memoryScope, chatId, tools, personaId = 'default' } = options;
    const maxSteps = options.maxSteps ?? cfg.maxSteps ?? 10;

    const sm = personaRegistry.getSoulManager(personaId);
    const personaConfig = sm.getConfig();

    const models = resolveModelList(
      this.config.model ?? personaConfig.model,
      personaConfig.fallbacks,
    );
    if (models.length === 0) {
      throw new Error('No LLM provider available — set at least one API key');
    }

    const [primary, ...fallbacks] = models;
    console.log(`[BaseAgent] Using model: ${primary.modelString}, persona: ${personaId}`);
    if (fallbacks.length) console.log(`[BaseAgent] Fallbacks: ${fallbacks.map(m => m.modelString).join(', ')}`);

    const systemPrompt = await this.getSystemPrompt(context, personaId);
    const temperature = this.getTemperature(personaId);
    const enableMemory = this.isMemoryEnabled();

    const fullMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const wrapModel = (model: LanguageModel): LanguageModel =>
      enableMemory && memoryScope && chatId
        ? wrapModelWithMemory(model, memoryScope, chatId, personaId)
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
          console.log(`[Agent] ── Step ${n} | finishReason: ${step.finishReason}`);

          if (step.toolCalls?.length) {
            for (const tc of step.toolCalls) {
              const inputSnippet = JSON.stringify(tc.input ?? tc.args ?? {}).slice(0, 300);
              console.log(`[Agent]  → tool_call  : ${tc.toolName}  ${inputSnippet}`);
            }
          }

          if (step.toolResults?.length) {
            for (const tr of step.toolResults) {
              const outputSnippet = String(tr.output ?? tr.result ?? '').slice(0, 300);
              console.log(`[Agent]  ← tool_result: ${tr.toolName}  ${outputSnippet}`);
            }
          }

          if (step.text) {
            console.log(`[Agent]  ✎ text: ${step.text.slice(0, 300)}`);
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
            personaId: personaId !== 'default' ? personaId : undefined,
          });
        },
      });

      console.log(`[Agent] Done after ${stepIndex} step(s). Final text length: ${result.text.length}`);
      return { type: 'text', text: result.text, result, provider: resolved.modelString };
    };

    const errors: string[] = [];

    try {
      return await tryGenerate(primary);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${primary.modelString}: ${msg}`);
      console.error(`[BaseAgent] Model ${primary.modelString} failed:`, msg);
    }

    for (const fallback of fallbacks) {
      try {
        console.log(`[BaseAgent] Trying fallback: ${fallback.modelString}...`);
        return await tryGenerate(fallback);
      } catch (fallbackError) {
        const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        errors.push(`${fallback.modelString}: ${msg}`);
        console.error(`[BaseAgent] Fallback ${fallback.modelString} failed:`, msg);
      }
    }

    throw new Error(`[LLM] All models failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

export const baseAgent = new BaseAgent();
