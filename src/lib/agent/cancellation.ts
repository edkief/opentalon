/**
 * In-process registries of AbortControllers for interruptible work.
 *
 * Two kinds live here:
 *
 *  - **Specialists** — keyed by specialistId, registered when a specialist
 *    starts and removed when it finishes. Only force cancellation applies.
 *  - **Turns** — keyed by chatId, registered for user-initiated supervisor
 *    turns so `/cancel` can interrupt the turn the user is actually watching.
 *    Supports two modes (see {@link TurnCancelMode}).
 *
 * Both only work within a single process — the bot process is the only one
 * actually executing LLM calls, so the cancel API route and the Telegram
 * command both signal that same process via these maps.
 */

const registry = new Map<string, AbortController>();

export const cancellationRegistry = {
  register(specialistId: string): AbortController {
    const controller = new AbortController();
    registry.set(specialistId, controller);
    return controller;
  },

  cancel(specialistId: string): boolean {
    const controller = registry.get(specialistId);
    if (!controller) return false;
    controller.abort();
    return true;
  },

  unregister(specialistId: string): void {
    registry.delete(specialistId);
  },

  isRegistered(specialistId: string): boolean {
    return registry.has(specialistId);
  },
};

/**
 * How a running turn should be stopped.
 *
 *  - `graceful` — set a flag; the executor's tool loop finishes the step that
 *    is already in flight, then stops and asks the model to summarise what it
 *    got done. Nothing is lost, but the user waits out the current tool call.
 *  - `force` — abort the AbortSignal immediately. `generateText` throws
 *    `AbortError` mid-flight; work in the current step is discarded.
 */
export type TurnCancelMode = 'graceful' | 'force';

interface TurnEntry {
  turnId: string;
  controller: AbortController;
  /** Set once cancellation has been asked for; escalates graceful → force. */
  requested?: TurnCancelMode;
  /**
   * Specialist ids spawned by this turn. Reference to the live set owned by the
   * turn, so a force cancel can cascade into background sub-agents instead of
   * leaving them burning tokens on an answer nobody will read.
   */
  jobIds?: Set<string>;
}

/** Outcome of a `/cancel` request, for the acknowledgement message. */
export type TurnCancelResult =
  | { status: 'none' }
  | { status: 'graceful' }
  | { status: 'force'; escalated: boolean };

const turns = new Map<string, TurnEntry>();

export const turnCancellation = {
  /**
   * Register a user-initiated turn as interruptible. Returns the signal to hand
   * to the SDK plus a `shouldStop` probe for the executor's `stopWhen` array.
   * Replaces any stale entry for the same chat (a previous turn that failed to
   * unregister) — the newest turn is the one the user means by `/cancel`.
   */
  register(
    chatId: string,
    turnId: string,
    jobIds?: Set<string>,
  ): { signal: AbortSignal; shouldStop: () => boolean } {
    const controller = new AbortController();
    turns.set(chatId, { turnId, controller, ...(jobIds ? { jobIds } : {}) });
    return {
      signal: controller.signal,
      shouldStop: () => turns.get(chatId)?.requested === 'graceful',
    };
  },

  /**
   * Ask the turn running in `chatId` to stop. A second request while a graceful
   * stop is still pending escalates to a force abort, so an impatient user can
   * just send `/cancel` twice rather than learning a flag.
   */
  request(chatId: string, mode: TurnCancelMode = 'graceful'): TurnCancelResult {
    const entry = turns.get(chatId);
    if (!entry) return { status: 'none' };

    const escalated = entry.requested === 'graceful' && mode === 'graceful';
    const effective: TurnCancelMode = escalated ? 'force' : mode;
    entry.requested = effective;

    if (effective === 'force') {
      entry.controller.abort();
      // Cascade: sub-agents spawned by this turn have no reader left.
      for (const specialistId of entry.jobIds ?? []) {
        cancellationRegistry.cancel(specialistId);
      }
      return { status: 'force', escalated };
    }
    return { status: 'graceful' };
  },

  /** The cancel mode requested for this chat's turn, if any. */
  requested(chatId: string): TurnCancelMode | undefined {
    return turns.get(chatId)?.requested;
  },

  /** True when a turn is currently registered for this chat. */
  isRunning(chatId: string): boolean {
    return turns.has(chatId);
  },

  /** Remove the entry, but only if it still belongs to `turnId`. */
  unregister(chatId: string, turnId: string): void {
    if (turns.get(chatId)?.turnId === turnId) turns.delete(chatId);
  },
};
