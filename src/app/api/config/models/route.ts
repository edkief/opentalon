import { NextResponse } from 'next/server';
import { configManager } from '@/lib/config';
import { getApiKeyForProvider, parseModelString } from '@/lib/agent/model-resolver';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AUTO_DETECT: Array<[string, string]> = [
  ['anthropic', 'claude-sonnet-4-6'],
  ['google',    'gemini-2.0-flash'],
  ['openai',    'gpt-4o'],
  ['mistral',   'mistral-large-latest'],
  ['minimax',   'MiniMax-M2.5'],
];

/**
 * GET /api/config/models
 * Returns the list of usable model strings derived from config + available API keys.
 * Used by the dashboard persona editor to populate model dropdowns.
 */
export async function GET() {
  const cfg = configManager.get().llm ?? {};
  const configured = [cfg.model, ...(cfg.fallbacks ?? [])].filter((s): s is string => Boolean(s));

  const extras = AUTO_DETECT
    .filter(([p, m]) => getApiKeyForProvider(p) && !configured.includes(`${p}/${m}`))
    .map(([p, m]) => `${p}/${m}`);

  const customProviders = configManager.getSecrets().providers?.map((p) => p.name) ?? [];
  const knownProviders = new Set(['anthropic', 'openai', 'mistral', 'minimax', 'google', ...customProviders]);

  const all = [...configured, ...extras].filter((s) => {
    const parsed = parseModelString(s);
    return parsed && knownProviders.has(parsed.provider) && Boolean(getApiKeyForProvider(parsed.provider));
  });

  return NextResponse.json({ models: all });
}
