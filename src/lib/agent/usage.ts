// Token-usage extraction shared across write sites.
//
// AI SDK v6 (`LanguageModelUsage`) exposes a breakdown the providers actually
// populate (Anthropic, OpenAI, Google all map into it):
//   inputTokens                      → TOTAL input, incl. cached
//   inputTokenDetails.cacheReadTokens  → cached input read (cheap tier)
//   inputTokenDetails.cacheWriteTokens → cache creation (Anthropic only; 0 else)
//   outputTokens                     → TOTAL output, incl. reasoning
//   outputTokenDetails.reasoningTokens → thinking tokens (subset of output)
//
// We persist the totals plus the cache/reasoning subsets. Non-cached input is
// derived (total − cacheRead − cacheWrite); reasoning is NOT added to cost —
// it's already inside outputTokens (billed at the output rate).

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

// Loosely-typed shape of the AI SDK usage object (older SDK builds surfaced a
// flatter shape; we read defensively so partial data still lands).
interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number; // deprecated flat field
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

/** Normalises an AI SDK step/result usage object into our stored shape. */
export function extractUsage(usage: RawUsage | undefined | null): TokenUsage {
  if (!usage) return {};
  const details = usage.inputTokenDetails;
  const outDetails = usage.outputTokenDetails;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: details?.cacheReadTokens ?? usage.cachedInputTokens,
    cacheWriteTokens: details?.cacheWriteTokens,
    reasoningTokens: outDetails?.reasoningTokens,
  };
}
