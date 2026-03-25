/**
 * Evaluates a JS boolean expression against inputData.
 * Only exposes { input } binding — no process/require access.
 * Throws if the expression cannot be evaluated.
 */
export function evaluateCondition(expression: string, inputData: Record<string, unknown>): boolean {
  try {
    const fn = new Function('input', `"use strict"; return !!(${expression})`);
    return Boolean(fn(inputData));
  } catch (err) {
    throw new Error(
      `Condition expression evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
