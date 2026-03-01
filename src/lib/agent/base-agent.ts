import { generateText, stepCountIs } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createMistral } from '@ai-sdk/mistral';
import type { LanguageModel } from 'ai';
import { soulManager } from '../soul';
import { configManager } from '../config';
import { wrapModelWithMemory } from './middleware';
import type { Message, ChatOptions, ChatResponse, AgentConfig } from './types';
import { emitStep } from './log-bus';
import { consumeRagContext } from './rag-store';

export type LLMProvider = 'anthropic' | 'openai' | 'mistral';

type ResolvedProvider = {
  name: LLMProvider;
  model: LanguageModel;
};

const PROVIDER_DEFAULTS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  mistral: 'mistral-large-latest',
};

function getApiKey(provider: LLMProvider): string | undefined {
  const secrets = configManager.getSecrets();
  switch (provider) {
    case 'anthropic': return secrets.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    case 'openai':    return secrets.openaiApiKey    ?? process.env.OPENAI_API_KEY;
    case 'mistral':   return secrets.mistralApiKey   ?? process.env.MISTRAL_API_KEY;
  }
}

function buildModel(provider: LLMProvider, modelId: string): LanguageModel {
  const key = getApiKey(provider);
  switch (provider) {
    case 'anthropic': return createAnthropic({ apiKey: key })(modelId);
    case 'openai':    return createOpenAI({ apiKey: key })(modelId);
    case 'mistral':   return createMistral({ apiKey: key })(modelId);
  }
}

/** Resolve provider list fresh on every call so hot-reload applies immediately. */
function resolveProviders(agentConfig: AgentConfig): ResolvedProvider[] {
  const cfg = configManager.get().llm ?? {};
  const preferredName = (cfg.provider ?? process.env.LLM_PROVIDER?.toLowerCase()) as LLMProvider | undefined;
  const modelOverride = cfg.model ?? process.env.LLM_MODEL;

  const order: LLMProvider[] = preferredName
    ? [preferredName, ...(['anthropic', 'openai', 'mistral'] as LLMProvider[]).filter(p => p !== preferredName)]
    : ['anthropic', 'mistral', 'openai'];

  return order
    .filter(name => !!getApiKey(name))
    .map(name => ({
      name,
      model: buildModel(
        name,
        (agentConfig.model ?? (name === preferredName ? modelOverride : undefined) ?? PROVIDER_DEFAULTS[name])!
      ),
    }));
}

export class BaseAgent {
  private config: AgentConfig;

  constructor(config: AgentConfig = {}) {
    this.config = config;
  }

  private async getSystemPrompt(context: string = ''): Promise<string> {
    const soulContent = soulManager.getContent();
    const identityContent = soulManager.getIdentityContent();

    const parts: string[] = [];
    if (identityContent) parts.push(`## Identity\n${identityContent}`);
    parts.push(`## Soul\n${soulContent}`);
    if (context) parts.push(`\n\nContext: ${context}`);

    return parts.join('');
  }

  private getTemperature(): number {
    return (
      this.config.temperature ??
      configManager.get().llm?.temperature ??
      soulManager.getConfig().temperature ??
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
    const { messages, context = '', memoryScope, chatId, tools } = options;
    const maxSteps = options.maxSteps ?? cfg.maxSteps ?? 10;

    const providers = resolveProviders(this.config);
    if (providers.length === 0) {
      throw new Error('No LLM provider available — set at least one API key');
    }

    const [primary, ...fallbacks] = providers;
    console.log(`[BaseAgent] Using provider: ${primary.name}`);
    if (fallbacks.length) console.log(`[BaseAgent] Fallbacks: ${fallbacks.map(p => p.name).join(', ')}`);

    const systemPrompt = await this.getSystemPrompt(context);
    const temperature = this.getTemperature();
    const enableMemory = this.isMemoryEnabled();

    const fullMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const wrapModel = (model: LanguageModel): LanguageModel =>
      enableMemory && memoryScope && chatId
        ? wrapModelWithMemory(model, memoryScope, chatId)
        : model;

    const toolOptions = tools && Object.keys(tools).length > 0
      ? { tools, toolChoice: 'auto' as const, stopWhen: stepCountIs(maxSteps) }
      : {};

    const tryGenerate = async (provider: ResolvedProvider): Promise<ChatResponse> => {
      let stepIndex = 0;

      const result = await generateText({
        model: wrapModel(provider.model),
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
            toolResults: step.toolResults?.map((tr: any) => ({ toolName: tr.toolName, output: String(tr.output ?? tr.result ?? '').slice(0, 500) })),
            ragContext: chatId ? consumeRagContext(chatId) : undefined,
          });
        },
      });

      console.log(`[Agent] Done after ${stepIndex} step(s). Final text length: ${result.text.length}`);
      return { type: 'text', text: result.text, result };
    };

    try {
      return await tryGenerate(primary);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[BaseAgent] Provider ${primary.name} failed:`, errorMessage);

      for (const provider of fallbacks) {
        try {
          console.log(`[BaseAgent] Trying fallback: ${provider.name}...`);
          return await tryGenerate(provider);
        } catch (fallbackError) {
          const errorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          console.error(`[BaseAgent] Fallback ${provider.name} failed:`, errorMsg);
        }
      }

      throw new Error('All LLM providers failed');
    }
  }
}

export const baseAgent = new BaseAgent();
