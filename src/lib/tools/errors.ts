/**
 * Canonical tool error helper (see docs/reviews/agentic-best-practices
 * recommendation #10: standardize tool error semantics).
 *
 * Convention applied across built-in tools:
 *   - Expected, recoverable conditions the model should react to and
 *     possibly retry differently (not-found, validation failure, user
 *     denial) return a string prefixed with `"Error: "` so the model can
 *     reliably tell success from failure by inspecting the text — but the
 *     multi-step loop continues normally with the string as tool output.
 *   - Unexpected/infrastructure failures (filesystem errors, subprocess
 *     crashes, network failures) THROW via `toolError()` so the AI SDK
 *     surfaces a structured `tool-error` content part. The multi-step loop
 *     still continues (the model sees the failure and can adapt), but the
 *     failure is now explicit and machine-distinguishable instead of just
 *     another string the model might mistake for real output — and it's
 *     counted in step logs via `mapStepToolResults` (agent/log-bus.ts),
 *     which flags `tool-error` parts with `isError: true`.
 */
export function toolError(message: string): never {
  throw new Error(message);
}

/** Formats a caught error/unknown value into a message string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
