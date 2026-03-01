import { generateText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { mistral } from '@ai-sdk/mistral';
import type { LanguageModel } from 'ai';
import { soulManager } from '../soul';
import { wrapModelWithMemory } from './middleware';
import type { Message, ChatOptions, ChatResponse, AgentConfig } from './types';
import { emitStep } from './log-bus';
import { consumeRagContext } from './rag-store';

export type LLMProvider = 'anthropic' | 'openai' | 'mistral';

type ModelProvider = {
  name: LLMProvider;
  model: LanguageModel;
  hasKey: boolean;
};

const PROVIDER_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  mistral: 'mistral-large-latest',
};

function hasApiKey(provider: LLMProvider): boolean {
  switch (provider) {
    case 'anthropic':
      return !!process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return !!process.env.OPENAI_API_KEY;
    case 'mistral':
      return !!process.env.MISTRAL_API_KEY;
  }
}

function getPreferredProvider(): LLMProvider | null {
  const pref = process.env.LLM_PROVIDER?.toLowerCase();
  if (pref === 'anthropic' || pref === 'openai' || pref === 'mistral') {
    return pref;
  }
  return null;
}

function getPreferredModel(): string | undefined {
  return process.env.LLM_MODEL || undefined;
}

function createProvider(name: LLMProvider, modelOverride?: string): ModelProvider {
  const modelId = modelOverride || PROVIDER_MODELS[name];

  let model: LanguageModel;
  switch (name) {
    case 'anthropic':
      model = anthropic(modelId);
      break;
    case 'openai':
      model = openai(modelId);
      break;
    case 'mistral':
      model = mistral(modelId);
      break;
  }

  return {
    name,
    model,
    hasKey: hasApiKey(name),
  };
}

export class BaseAgent {
  private primaryProvider: ModelProvider | null;
  private fallbackProviders: ModelProvider[];
  private config: AgentConfig;
  private enableMemory: boolean;

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.enableMemory = process.env.ENABLE_MEMORY !== 'false';

    const preferredProvider = getPreferredProvider();
    const preferredModel = getPreferredModel();

    // Initialize all available providers
    const allProviders: ModelProvider[] = [
      createProvider('anthropic', preferredProvider === 'anthropic' ? preferredModel : undefined),
      createProvider('mistral', preferredProvider === 'mistral' ? preferredModel : undefined),
      createProvider('openai', preferredProvider === 'openai' ? preferredModel : undefined),
    ].filter(p => p.hasKey);

    if (allProviders.length === 0) {
      console.warn('[BaseAgent] No LLM providers available - set at least one API key');
      this.primaryProvider = null;
      this.fallbackProviders = [];
      return;
    }

    // If user specified a preferred provider, use it as primary
    if (preferredProvider) {
      const preferred = allProviders.find(p => p.name === preferredProvider);
      if (preferred) {
        this.primaryProvider = preferred;
        this.fallbackProviders = allProviders.filter(p => p.name !== preferredProvider);
      } else {
        // Preferred provider doesn't have API key, use first available
        this.primaryProvider = allProviders[0];
        this.fallbackProviders = allProviders.slice(1);
      }
    } else {
      // No preference - use first available as primary
      this.primaryProvider = allProviders[0];
      this.fallbackProviders = allProviders.slice(1);
    }

    console.log(`[BaseAgent] Primary provider: ${this.primaryProvider.name}`);
    if (this.fallbackProviders.length > 0) {
      console.log(`[BaseAgent] Fallback providers: ${this.fallbackProviders.map(p => p.name).join(', ')}`);
    }
  }

  private async getSystemPrompt(context: string = ''): Promise<string> {
    const soulContent = soulManager.getContent();
    const identityContent = soulManager.getIdentityContent();

    const parts: string[] = [];

    // Identity comes first (hard facts)
    if (identityContent) {
      parts.push(`## Identity\n${identityContent}`);
    }

    // Soul comes second (personality)
    parts.push(`## Soul\n${soulContent}`);

    if (context) {
      parts.push(`\n\nContext: ${context}`);
    }

    return parts.join('');
  }

  private getTemperature(): number {
    return (
      this.config.temperature ??
      soulManager.getConfig().temperature ??
      0.7
    );
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const { messages, context = '', memoryScope, chatId, tools, maxSteps = 10 } = options;

    if (!this.primaryProvider) {
      throw new Error('No LLM provider available');
    }

    const systemPrompt = await this.getSystemPrompt(context);
    const temperature = this.getTemperature();

    // Build messages with system prompt
    const fullMessages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // Wrap model with RAG middleware when memory is enabled and scope/chatId are provided
    const wrapModel = (model: LanguageModel): LanguageModel =>
      this.enableMemory && memoryScope && chatId
        ? wrapModelWithMemory(model, memoryScope, chatId)
        : model;

    // Tool options — only passed when tools are provided to keep calls lean
    const toolOptions = tools && Object.keys(tools).length > 0
      ? { tools, toolChoice: 'auto' as const, stopWhen: stepCountIs(maxSteps) }
      : {};

    const tryGenerate = async (model: LanguageModel): Promise<ChatResponse> => {
      let stepIndex = 0;

      const result = await generateText({
        model: wrapModel(model),
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

    // Try primary provider, then fallbacks
    try {
      return await tryGenerate(this.primaryProvider.model);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[BaseAgent] Primary provider ${this.primaryProvider.name} failed:`, errorMessage);

      for (const provider of this.fallbackProviders) {
        try {
          console.log(`[BaseAgent] Trying fallback: ${provider.name}...`);
          return await tryGenerate(provider.model);
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
