// Cost estimation from token usage + a config-provided rate card.
//
// No provider exposes a usable pricing API (Anthropic/OpenAI/Mistral have none;
// Vertex only via the Cloud Billing Catalog). Rates therefore come from
// config.yaml `llm.pricing` — see src/lib/config/schema.ts. They can be seeded
// from OpenRouter's public /models endpoint and then hand-edited.
//
// Rates are USD per 1,000,000 tokens.

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type PricingMap = Record<string, ModelPricing>;

/** Token buckets for one model (as summed from the DB). */
export interface TokenBuckets {
  inputTokens: number; // TOTAL input, incl. cache (matches stored input_tokens)
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const PER_MILLION = 1_000_000;

/**
 * Resolves a stored model string ("provider/model") against the rate card.
 * Falls back to a bare model-name match so a "openai/gpt-4o" card entry still
 * prices a row stored as "gpt-4o" and vice-versa.
 */
export function resolvePricing(model: string | null | undefined, pricing: PricingMap): ModelPricing | undefined {
  if (!model) return undefined;
  if (pricing[model]) return pricing[model];
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  if (pricing[bare]) return pricing[bare];
  // Match a card key whose bare name equals ours (handles provider-prefix drift).
  for (const [key, val] of Object.entries(pricing)) {
    const keyBare = key.includes('/') ? key.split('/').pop()! : key;
    if (keyBare === bare) return val;
  }
  return undefined;
}

/**
 * USD cost for one model's token buckets. Non-cached input is derived
 * (total − cacheRead − cacheWrite, clamped ≥0). cacheRead/cacheWrite default to
 * the input rate when the card omits them. Reasoning tokens are already inside
 * outputTokens and are NOT priced separately.
 */
export function costForBuckets(buckets: TokenBuckets, price: ModelPricing): number {
  const cacheRead = Math.max(0, buckets.cacheReadTokens);
  const cacheWrite = Math.max(0, buckets.cacheWriteTokens);
  const nonCached = Math.max(0, buckets.inputTokens - cacheRead - cacheWrite);
  const readRate = price.cacheRead ?? price.input;
  const writeRate = price.cacheWrite ?? price.input;
  return (
    (nonCached * price.input +
      cacheRead * readRate +
      cacheWrite * writeRate +
      Math.max(0, buckets.outputTokens) * price.output) /
    PER_MILLION
  );
}

/** Cost for buckets, or undefined when the model has no rate-card entry. */
export function estimateCost(
  model: string | null | undefined,
  buckets: TokenBuckets,
  pricing: PricingMap,
): number | undefined {
  const price = resolvePricing(model, pricing);
  if (!price) return undefined;
  return costForBuckets(buckets, price);
}
