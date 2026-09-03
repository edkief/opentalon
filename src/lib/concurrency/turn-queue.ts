/**
 * The one turn queue for the whole process.
 *
 * A "turn" is one agent run for one conversation. Turns for the same
 * conversation must not interleave — two turns over the same history would each
 * read a transcript the other is about to append to. Turns for *different*
 * conversations should run in parallel.
 *
 * This used to exist twice: a per-chatId promise chain in
 * `src/lib/telegram/state.ts` and an independent copy with its own map in
 * `src/lib/embed/process-message.ts`. Two maps meant two different answers to
 * "is a turn already running for this chat", which is a bug waiting for a chat
 * that happens to be driven by both channels.
 *
 * ## Identity vs. address
 *
 * A {@link TurnKey} carries both parts of a conversation's identity:
 *
 *  - `threadId` — *which conversation*: whose history this turn reads and
 *    appends to. Opaque; never parsed.
 *  - `chatId` — *where the reply goes*. Shape carries the channel (numeric →
 *    Telegram, `email:` / `embed:` prefixes → those channels).
 *
 * Today every caller has only a chatId, and a chat's root thread is defined as
 * `threadId === chatId` (see {@link toTurnKey}). {@link serializationKey}
 * chooses which half decides serialization, and it currently picks `chatId`:
 * one turn at a time per chat, exactly today's behaviour. Flipping that single
 * line to `threadId` is what enables per-thread concurrency — but read the
 * caveat on {@link __setSerializationKeyForTest} before doing it.
 *
 * The map lives on `globalThis` so it survives Next.js dev HMR — the same
 * pattern `src/lib/channels/registry.ts:42` uses for the channel registry. A
 * module-level map would be re-created on reload and let a second turn start
 * while the first is still running.
 */

/** A conversation's identity (`threadId`) and its routing address (`chatId`). */
export interface TurnKey {
  threadId: string;
  chatId: string;
}

/**
 * Which half of a {@link TurnKey} turns are serialized on.
 *
 * Serialize per chat now, per thread later: flip this one line to `k.threadId`
 * to let separate threads in one chat run concurrently.
 */
export function serializationKey(k: TurnKey): string {
  return k.chatId;
}

// Indirection so the test suite can exercise the per-thread flip without
// editing the source. Production code never reassigns this.
let keyFn: (k: TurnKey) => string = serializationKey;

/**
 * Widen a bare chatId from a pre-thread caller into a full key. A chat's root
 * thread is `threadId === chatId` verbatim, so this is lossless: callers that
 * learn about threads later pass a real TurnKey and nothing else changes.
 */
export function toTurnKey(key: TurnKey | string): TurnKey {
  return typeof key === 'string' ? { threadId: key, chatId: key } : key;
}

/**
 * The map key a turn serializes under. Anything that needs to agree with the
 * queue about what "one turn" means — notably the cancellation registry in
 * `src/lib/agent/cancellation.ts` — must derive its key from here rather than
 * keying on a chatId of its own, or the two can silently disagree.
 */
export function turnKeyOf(key: TurnKey | string): string {
  return keyFn(toTurnKey(key));
}

/** One in-flight turn per key; different keys proceed in parallel. */
function queues(): Map<string, Promise<void>> {
  const g = globalThis as typeof globalThis & { __turnQueues?: Map<string, Promise<void>> };
  if (!g.__turnQueues) g.__turnQueues = new Map();
  return g.__turnQueues;
}

/**
 * Serialize a task behind any prior task queued for the same conversation.
 *
 * Returns immediately — the task runs on the chain, and a rejection is logged
 * rather than propagated so one failed turn never stalls the ones behind it.
 */
export function enqueueForTurn(key: TurnKey | string, task: () => Promise<void>): void {
  const map = queues();
  const k = turnKeyOf(key);
  const prev = map.get(k) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch((e) => console.error('[Queue]', e))
    .finally(() => {
      // Only drop the entry if this is still the tail, or a turn queued behind
      // us would lose its predecessor and start early.
      if (map.get(k) === next) map.delete(k);
    });
  map.set(k, next);
}

/** True when a turn is queued or running for this conversation. Test/diagnostic use. */
export function hasQueuedTurn(key: TurnKey | string): boolean {
  return queues().has(turnKeyOf(key));
}

/**
 * Swap the serialization key for a test, returning a restore function.
 *
 * Exists because flipping {@link serializationKey} for real is not yet safe:
 * `turnKeyOf` is shared with the cancellation registry by design (they must
 * never disagree about what one turn is), and every `/cancel` entry point —
 * `src/lib/telegram/commands/cancel.ts`, `src/app/api/turn/cancel/route.ts` —
 * still knows only a chatId. Thread-keyed cancellation is deferred work; until
 * it lands, the flip belongs in tests only.
 */
export function __setSerializationKeyForTest(fn: (k: TurnKey) => string): () => void {
  keyFn = fn;
  return () => {
    keyFn = serializationKey;
  };
}
