import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { configManager } from '../config';
import { createMinimaxOpenAI } from 'vercel-minimax-ai-provider';

export interface ResolvedModel {
  modelString: string;
  model: LanguageModel;
}

/** Auto-detect priority when no model is configured anywhere. */
const AUTO_DETECT_ORDER: Array<[string, string]> = [
  ['anthropic', 'claude-sonnet-4-5'],
  ['google',    'gemini-2.0-flash'],
  ['openai',    'gpt-4o'],
  ['mistral',   'mistral-large-latest'],
  ['minimax',   'MiniMax-M2.5'],
];

export function parseModelString(s: string): { provider: string; modelId: string } | null {
  const idx = s.indexOf('/');
  if (idx === -1) return null;
  return { provider: s.slice(0, idx), modelId: s.slice(idx + 1) };
}

export function getApiKeyForProvider(provider: string): string | undefined {
  const secrets = configManager.getSecrets();
  // auth map takes precedence, then env var fallback
  return secrets.auth?.[provider] ?? process.env[`${provider.toUpperCase()}_API_KEY`];
}

export function buildLanguageModel(provider: string, modelId: string): LanguageModel {
  const apiKey = getApiKeyForProvider(provider);
  switch (provider) {
    case 'anthropic': return createAnthropic({ apiKey })(modelId);
    case 'openai':    return createOpenAI({ apiKey })(modelId);
    case 'mistral':   return createMistral({ apiKey })(modelId);
    case 'minimax':   return createMinimaxOpenAI({ apiKey })(modelId);
    case 'google':    return createGoogleGenerativeAI({ apiKey })(modelId);
    default: {
      const custom = configManager.getSecrets().providers?.find(p => p.name === provider);
      if (!custom) {
        throw new Error(`Unknown provider "${provider}" — add it to secrets.yaml providers[] with a name and baseURL`);
      }
      return createOpenAICompatible({ name: provider, baseURL: custom.baseURL, apiKey })(modelId);
    }
  }
}

function autoDetectModel(): string | undefined {
  for (const [provider, defaultModel] of AUTO_DETECT_ORDER) {
    if (getApiKeyForProvider(provider)) return `${provider}/${defaultModel}`;
  }
  return undefined;
}

function resolveModelString(modelString: string): ResolvedModel | null {
  const parsed = parseModelString(modelString);
  if (!parsed) return null;
  const { provider, modelId } = parsed;
  try {
    const model = buildLanguageModel(provider, modelId);
    return { modelString, model };
  } catch {
    return null;
  }
}

/**
 * Resolve the main model + fallbacks into an ordered list of LanguageModel instances.
 *
 * Priority for the primary model (first non-null wins):
 *   1. modelOverride arg  — per-call or agent config
 *   2. config.yaml llm.model
 *   3. LLM_MODEL env var
 *   4. Auto-detect: first provider with a key available
 *
 * Fallbacks: fallbackOverride arg → config.yaml llm.fallbacks → []
 *
 * Throws if zero models are resolvable.
 */
export function resolveModelList(modelOverride?: string, fallbackOverride?: string[]): ResolvedModel[] {
  const cfg = configManager.get().llm ?? {};

  const primaryString =
    modelOverride ??
    cfg.model ??
    process.env.LLM_MODEL ??
    autoDetectModel();

  const fallbackStrings = fallbackOverride ?? cfg.fallbacks ?? [];

  const allStrings = [primaryString, ...fallbackStrings].filter((s): s is string => Boolean(s));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = allStrings.filter(s => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  const resolved = unique.map(resolveModelString).filter((r): r is ResolvedModel => r !== null);

  if (resolved.length === 0) {
    throw new Error(
      'No LLM provider available — set at least one API key and configure llm.model in config.yaml'
    );
  }

  return resolved;
}
