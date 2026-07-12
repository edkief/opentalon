/**
 * Channel registry — the app-wide outbound seam.
 *
 * A "channel" is implicit in the shape of a `chatId`:
 *   - numeric (`/^-?\d+$/`)  → Telegram
 *   - `web`                  → dashboard chat (no push channel; silent no-op)
 *   - `email:<16-hex>`       → email thread
 *
 * Historically `sendToChat` lived in `src/lib/telegram/send.ts` and silently
 * dropped any non-numeric chatId. That coupled every app-wide push (workflow
 * notifications, scheduled tasks, guidance prompts, job completions) to
 * Telegram. This registry owns routing instead: each channel registers a
 * sender under a prefix (or the numeric/telegram pseudo-prefix) and
 * `sendToChat` dispatches by chatId shape. Unrouted chatIds are a silent no-op,
 * preserving today's `web` behavior.
 *
 * The registry is stored on `globalThis` so it survives Next.js dev HMR — the
 * same pattern `src/lib/bot-manager.ts` uses for the bot instance.
 */

export type ChannelSendFormat =
  | 'markdown'
  | 'html'
  | { parse_mode?: 'HTML'; reply_markup?: unknown };

export type ChannelSender = (
  chatId: string,
  text: string,
  formatOrOptions?: ChannelSendFormat,
  throwOnError?: boolean,
) => Promise<void>;

// Pseudo-prefix key for the numeric/telegram sender. Numeric chatIds don't
// carry a literal prefix, so they're routed via this reserved key.
const TELEGRAM_KEY = '#telegram';

interface ChannelRegistry {
  // Prefix (e.g. 'email:') → sender. TELEGRAM_KEY holds the numeric sender.
  senders: Map<string, ChannelSender>;
}

function getRegistry(): ChannelRegistry {
  const g = globalThis as typeof globalThis & { __channelRegistry?: ChannelRegistry };
  if (!g.__channelRegistry) {
    g.__channelRegistry = { senders: new Map() };
  }
  return g.__channelRegistry;
}

/**
 * Register a sender for a chatId prefix. Use the literal prefix (including any
 * trailing separator, e.g. `'email:'`). The reserved key `'#telegram'` binds
 * the sender for numeric chatIds — callers should prefer registerTelegramSender.
 */
export function registerChannelSender(prefix: string, sender: ChannelSender): void {
  getRegistry().senders.set(prefix, sender);
}

/** Register the sender used for numeric (Telegram) chatIds. */
export function registerTelegramSender(sender: ChannelSender): void {
  getRegistry().senders.set(TELEGRAM_KEY, sender);
}

/** Resolve the sender responsible for a chatId, or null if none is registered. */
function resolveSender(chatId: string): ChannelSender | null {
  const { senders } = getRegistry();

  // Longest matching registered prefix wins (e.g. 'email:' beats 'e').
  let best: { prefix: string; sender: ChannelSender } | null = null;
  for (const [prefix, sender] of senders) {
    if (prefix === TELEGRAM_KEY) continue;
    if (chatId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, sender };
    }
  }
  if (best) return best.sender;

  // Numeric chatId → telegram sender if one is registered.
  if (/^-?\d+$/.test(chatId)) {
    return senders.get(TELEGRAM_KEY) ?? null;
  }

  return null;
}

/**
 * Send text to a chat by ID, dispatching to the channel that owns the chatId.
 *
 * If no channel is registered for the chatId (e.g. `web`, or email/telegram not
 * configured), this is a silent no-op — callers that run code after sendToChat
 * (e.g. addMessage) still execute. This preserves the historical behavior of
 * the Telegram-only `sendToChat` at `send.ts:44`.
 */
export async function sendToChat(
  chatId: string,
  text: string,
  formatOrOptions?: ChannelSendFormat,
  throwOnError = false,
): Promise<void> {
  const sender = resolveSender(chatId);
  if (!sender) return;
  await sender(chatId, text, formatOrOptions, throwOnError);
}
