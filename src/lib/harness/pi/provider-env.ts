/**
 * The environment variable pi reads each provider's API key from, for the providers OpenTalon
 * builds in (`buildLanguageModel` in src/lib/agent/model-resolver.ts). Taken from pi-ai's
 * `getApiKeyEnvVars` (dist/env-api-keys.js, pi 1.2.0). The names differ from OpenTalon's own
 * env fallback in places: pi reads Google's key from GEMINI_API_KEY, not GOOGLE_API_KEY.
 *
 * OpenTalon's custom OpenAI-compatible providers (secrets.yaml `providers[]`) are unknown to pi
 * without a models.json of its own, so they have no entry here.
 */
const PI_KEY_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  minimax: 'MINIMAX_API_KEY',
};

export const PI_PROVIDERS = Object.keys(PI_KEY_VARS);

/**
 * The environment that hands pi `provider`'s key: `{ <VAR>: key }`, `{}` when there is no key
 * to hand over (pi may still find one of its own), and undefined for a provider pi cannot be
 * given a key for.
 */
export function piProviderEnv(provider: string, key: string | undefined): Record<string, string> | undefined {
  const name = PI_KEY_VARS[provider];
  if (!name) return undefined;
  return key ? { [name]: key } : {};
}
