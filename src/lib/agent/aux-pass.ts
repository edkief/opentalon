import type { StepPhase } from './log-bus';

/**
 * The post-turn passes that run *after* the main generation has already
 * produced a reply: the max-steps summary, the finalise turn, and the
 * todo-check turn.
 */
export type AuxPhase = Extract<StepPhase, 'summary' | 'finalise' | 'todo-check'>;

export interface AuxPassFailure {
  phase: AuxPhase;
  /** The model the pass ran on — which is NOT necessarily the main turn's model. */
  modelString: string;
  /** `err.message`, or the stringified value for a non-Error throw. */
  message: string;
  error: unknown;
}

export interface AuxPassOptions {
  phase: AuxPhase;
  modelString: string;
  /** The turn's abort signal, when it has one. Used to recognise cancellation. */
  abortSignal?: AbortSignal;
  /** Called once when the pass fails non-fatally. Never called on an abort. */
  onFailure?: (failure: AuxPassFailure) => void;
}

/**
 * True when an error represents turn cancellation rather than a real failure.
 * Providers wrap aborts inconsistently, so this checks our own signal first and
 * only then the error's shape.
 */
function isCancellation(err: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Runs a post-turn auxiliary pass so a failure inside it cannot destroy a main
 * turn that already succeeded. Returns the pass's value, or `undefined` if it
 * failed — callers degrade to the reply they already hold.
 *
 * Why this exists: these passes were previously unguarded inside the fallback
 * loop's `tryGenerate`, which had two bad consequences.
 *
 *  1. **Misattribution.** The exception surfaced as
 *     `${mainModel} failed`, even though a pass may run on a *different* model
 *     (an agent's `finaliseModel`, or `llm.auxModel`). A dead aux endpoint was
 *     reported as `Fallback minimax/MiniMax-M3 failed: ... getaddrinfo
 *     ENOTFOUND llama-qwen25-3b.llama` — a host MiniMax never talks to.
 *
 *  2. **Discarded work.** A completed main turn (45 steps / 78k tokens / 9.7
 *     minutes, in the reported case) was thrown away and replayed in full —
 *     every side-effecting tool call included — on the next fallback model,
 *     which then failed at the very same unreachable aux model. N fallbacks,
 *     N full turns, one guaranteed identical failure.
 *
 * All three passes are optional polish over a reply that already exists, so the
 * correct degradation is to keep that reply. This mirrors the compactor, which
 * already wraps its aux `generateText` and returns a reason instead of throwing.
 *
 * Cancellation is re-thrown rather than swallowed: a force `/cancel` surfaces as
 * an AbortError and the executor's outer handler turns it into the "⏹ Stopped"
 * reply, so absorbing it here would report a cancelled turn as a completed one.
 */
export async function runAuxPass<T>(
  opts: AuxPassOptions,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (isCancellation(err, opts.abortSignal)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    opts.onFailure?.({ phase: opts.phase, modelString: opts.modelString, message, error: err });
    return undefined;
  }
}
