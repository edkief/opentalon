import crypto from 'node:crypto';
import type { ToolSet } from 'ai';
import { configManager } from '../config';
import { copyToolFamily } from './family-metadata';
import { toolError } from './errors';

/**
 * Repeated-tool-call circuit breaker (#56).
 *
 * `stopWhen: stepCountIs(maxSteps)` is the only thing that bounds a model stuck
 * re-issuing the same tool call, and it is a blunt instrument: it burns the
 * whole step budget (and the matching token spend) before firing, then reports
 * itself as a max-steps summary rather than as the bug it was. This is the
 * defence-in-depth layer, applied uniformly at the tool-execution seam so every
 * read-shaped tool — `todo_update`, `list_schedules`, `memory_recall`,
 * `read_file`, … — is covered rather than just the one that happened to loop.
 *
 * Detection is a **sliding window**, not a consecutive run. Degenerate loops are
 * frequently alternating (A-B-A-B-A-B) rather than a single call repeated
 * back-to-back, and a strictly-consecutive counter never sees those: the
 * intervening B resets it every time. So the breaker trips when the same
 * `(toolName, normalized input)` key occurs `repeats` times within the last
 * `window` calls.
 *
 * That alone would punish a legitimate poll-modify-poll cycle (read a file,
 * edit it, read it back), so by default the breaker additionally requires that
 * every prior occurrence of the key returned **identical output** — the
 * "identical input → identical output" property that makes a loop stable in the
 * first place. A re-read whose content changed between edits therefore never
 * trips it. Outputs are compared by hash, never retained raw, so the bookkeeping
 * stays O(window) small regardless of how large tool results are.
 *
 * Scope is per breaker instance, and callers create one per execution context
 * (one supervisor turn, one specialist run). Counters therefore cannot leak
 * across turns, and a specialist's calls can never collide with its
 * supervisor's.
 */

export interface LoopBreakerSettings {
  enabled: boolean;
  /** Identical calls within `window` needed to trip the breaker. */
  repeats: number;
  /** How many recent calls to look back over. */
  window: number;
  /** Require every prior occurrence to have returned the same output hash. */
  requireIdenticalOutput: boolean;
  /** Hash only the first N chars of output; 0 hashes the full payload. */
  outputHashChars: number;
}

export const LOOP_BREAKER_DEFAULTS: LoopBreakerSettings = {
  enabled: true,
  repeats: 3,
  window: 6,
  requireIdenticalOutput: true,
  outputHashChars: 0,
};

/** Resolve config over the defaults. Read per breaker so hot-reload applies to the next turn. */
export function resolveLoopBreakerSettings(): LoopBreakerSettings {
  const cfg = configManager.get().tools?.loopBreaker ?? {};
  const settings: LoopBreakerSettings = {
    enabled: cfg.enabled ?? LOOP_BREAKER_DEFAULTS.enabled,
    repeats: cfg.repeats ?? LOOP_BREAKER_DEFAULTS.repeats,
    window: cfg.window ?? LOOP_BREAKER_DEFAULTS.window,
    requireIdenticalOutput: cfg.requireIdenticalOutput ?? LOOP_BREAKER_DEFAULTS.requireIdenticalOutput,
    outputHashChars: cfg.outputHashChars ?? LOOP_BREAKER_DEFAULTS.outputHashChars,
  };
  // A window smaller than the repeat count can never hold enough occurrences to
  // trip, which would silently disable the breaker. Widen rather than ignore.
  if (settings.window < settings.repeats) settings.window = settings.repeats;
  return settings;
}

/**
 * Stable stringify: object keys are emitted in sorted order at every depth, so
 * two calls that differ only in key ordering hash to the same key. Models
 * re-emitting a tool call rarely reproduce key order byte-for-byte, and treating
 * those as distinct would let a loop slip through.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Call key: tool name plus normalized input. */
export function callKey(toolName: string, input: unknown): string {
  return `${toolName}:${hash(stableStringify(input))}`;
}

/** Coerce any tool return value to the text we hash. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function outputHash(output: unknown, maxChars: number): string {
  const text = outputText(output);
  return hash(maxChars > 0 ? text.slice(0, maxChars) : text);
}

interface CallRecord {
  key: string;
  /** null when the call threw — a failing call is not evidence of a stable loop. */
  outputHash: string | null;
}

export interface LoopBreaker {
  /**
   * Decide whether a call should be blocked. Returns the number of prior
   * matching occurrences when tripped, or null to let the call through.
   */
  check(toolName: string, input: unknown): number | null;
  /** Record a completed call so later calls can see it. */
  record(toolName: string, input: unknown, output: unknown, failed?: boolean): void;
  readonly settings: LoopBreakerSettings;
}

export function createLoopBreaker(settings = resolveLoopBreakerSettings()): LoopBreaker {
  const recent: CallRecord[] = [];

  return {
    settings,
    check(toolName, input) {
      if (!settings.enabled) return null;
      const key = callKey(toolName, input);
      const matches = recent.filter((r) => r.key === key);
      // The current call would be the (matches.length + 1)th occurrence.
      if (matches.length + 1 < settings.repeats) return null;
      if (settings.requireIdenticalOutput) {
        // Every prior occurrence must have succeeded and returned the same
        // output. A changed result means the call is doing real work.
        const first = matches[0].outputHash;
        if (first === null || !matches.every((m) => m.outputHash === first)) return null;
      }
      return matches.length;
    },
    record(toolName, input, output, failed = false) {
      if (!settings.enabled) return;
      recent.push({
        key: callKey(toolName, input),
        outputHash: failed ? null : outputHash(output, settings.outputHashChars),
      });
      // Keep only the last `window` calls.
      if (recent.length > settings.window) recent.splice(0, recent.length - settings.window);
    },
  };
}

function breakerMessage(toolName: string, occurrences: number): string {
  return (
    `Loop detected: you have already called \`${toolName}\` ${occurrences} times with these exact ` +
    `arguments and it returned the same result every time. This call was not executed. ` +
    `Repeating it will not produce a different result — change the arguments, use a different ` +
    `tool, or move on to the next step and finish the task.`
  );
}

type ExecutableTool = { execute?: (...args: unknown[]) => unknown };

/**
 * Wrap a ToolSet so every executable tool runs through `breaker`.
 *
 * Tools are cloned rather than mutated in place, because the caller's ToolSet
 * may be shared with code that did not ask for a breaker. Cloning breaks the
 * identity-keyed family WeakMap (`family-metadata.ts`), which the deferred
 * tool-discovery path (#53) depends on, so family metadata is explicitly copied
 * onto each clone. Tools without an `execute` (provider-executed or
 * schema-only) are passed through untouched.
 */
export function withLoopBreaker(
  tools: ToolSet | undefined,
  breaker: LoopBreaker,
  contextLabel: string,
): ToolSet | undefined {
  if (!tools || !breaker.settings.enabled) return tools;

  const wrapped: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const original = toolDef as ExecutableTool;
    if (typeof original.execute !== 'function') {
      wrapped[name] = toolDef;
      continue;
    }
    const originalExecute = original.execute.bind(original);

    const clone = {
      ...toolDef,
      execute: async (...args: unknown[]) => {
        const input = args[0];
        const occurrences = breaker.check(name, input);
        if (occurrences !== null) {
          // console is patched into logBus (telemetry.ts), so this reaches the
          // dashboard log viewer. The thrown error additionally surfaces as a
          // `tool-error` content part, flagged isError in step events.
          console.warn(
            `[LoopBreaker] ${contextLabel}: blocked ${name} after ${occurrences} identical call(s) ` +
              `within the last ${breaker.settings.window}`,
          );
          toolError(breakerMessage(name, occurrences));
        }
        try {
          const output = await originalExecute(...args);
          breaker.record(name, input, output);
          return output;
        } catch (err) {
          breaker.record(name, input, undefined, true);
          throw err;
        }
      },
    } as typeof toolDef;

    copyToolFamily(toolDef, clone);
    wrapped[name] = clone;
  }
  return wrapped;
}
