import { NextResponse } from 'next/server';
import { configManager } from '@/lib/config';
import type { PricingMap } from '@/lib/metrics/cost';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// OpenRouter is the only major public pricing API (no auth needed). We use it
// purely as a data source to SEED the config rate card — it is never called on
// the request hot path. The user pastes the returned YAML into config.yaml
// (`llm.pricing`) and edits from there.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

// OpenRouter prices are USD-per-token strings; we store USD-per-million.
function perMillion(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000 * 1_000_000) / 1_000_000; // 6dp
}

function bareName(model: string): string {
  return model.includes('/') ? model.split('/').pop()! : model;
}

// Normalise for fuzzy matching: OpenRouter ids use dots ("claude-sonnet-4.5")
// where provider ids use dashes ("claude-sonnet-4-5"). Strip all non-alphanumerics.
function normKey(model: string): string {
  return bareName(model).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    // Models to price: query param (comma list) ∪ configured model + fallbacks.
    const cfg = configManager.get().llm ?? {};
    const requested = (searchParams.get('models') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const wanted = Array.from(
      new Set([...(cfg.model ? [cfg.model] : []), ...(cfg.fallbacks ?? []), ...requested].filter(Boolean)),
    );

    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `OpenRouter returned ${res.status}` }, { status: 502 });
    }
    const body = (await res.json()) as { data?: OpenRouterModel[] };
    const models = body.data ?? [];

    // Index by full id, bare name, and normalised name for flexible matching.
    const byId = new Map<string, OpenRouterModel>();
    const byBare = new Map<string, OpenRouterModel>();
    const byNorm = new Map<string, OpenRouterModel>();
    for (const m of models) {
      byId.set(m.id, m);
      if (!byBare.has(bareName(m.id))) byBare.set(bareName(m.id), m);
      if (!byNorm.has(normKey(m.id))) byNorm.set(normKey(m.id), m);
    }

    const pricing: PricingMap = {};
    const matched: string[] = [];
    const unmatched: string[] = [];

    for (const key of wanted) {
      const m = byId.get(key) ?? byBare.get(bareName(key)) ?? byNorm.get(normKey(key));
      const input = perMillion(m?.pricing?.prompt);
      const output = perMillion(m?.pricing?.completion);
      if (!m || input === undefined || output === undefined) {
        unmatched.push(key);
        continue;
      }
      const entry: PricingMap[string] = { input, output };
      const cacheRead = perMillion(m.pricing?.input_cache_read);
      const cacheWrite = perMillion(m.pricing?.input_cache_write);
      if (cacheRead !== undefined) entry.cacheRead = cacheRead;
      if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
      pricing[key] = entry;
      matched.push(key);
    }

    // Ready-to-paste YAML block for config.yaml.
    let yaml = 'llm:\n  pricing:\n';
    if (matched.length === 0) {
      yaml += '    # No matching models found on OpenRouter — add entries manually.\n';
    } else {
      for (const key of matched) {
        const p = pricing[key];
        yaml += `    "${key}":\n`;
        yaml += `      input: ${p.input}\n`;
        yaml += `      output: ${p.output}\n`;
        if (p.cacheRead !== undefined) yaml += `      cacheRead: ${p.cacheRead}\n`;
        if (p.cacheWrite !== undefined) yaml += `      cacheWrite: ${p.cacheWrite}\n`;
      }
    }

    return NextResponse.json({ pricing, yaml, matched, unmatched });
  } catch (error) {
    console.error('[Metrics/pricing] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch OpenRouter pricing' }, { status: 500 });
  }
}
