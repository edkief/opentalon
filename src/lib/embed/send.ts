/**
 * Outbound delivery for the embed channel.
 *
 * Registered with the channel registry under the `embed:` prefix, which is the
 * whole point of routing through it: everything the app pushes to a chat —
 * agent replies, scheduled-task output, workflow completions, job results,
 * request_guidance prompts — goes through `sendToChat` and therefore reaches an
 * embedded bubble automatically. The `web` chatId drops all of those today
 * (src/lib/channels/registry.ts:14-15).
 *
 * An HTTP host has no push address, so "sending" means appending to the durable
 * per-chat outbox and emitting a live event for any attached SSE stream. A
 * client that is offline picks the message up on its next cursor read.
 */

import { logBus, type EmbedOutboxEvent } from '../agent/log-bus';
import { pushEmbedOutbox } from '../db/embed';
import { registerChannelSender, type ChannelSendFormat } from '../channels/registry';
import { EMBED_CHAT_PREFIX, isEmbedChatId } from './threads';

/** Normalise the registry's loose format argument to what the outbox stores. */
function formatOf(formatOrOptions?: ChannelSendFormat): 'markdown' | 'html' {
  if (formatOrOptions === 'html') return 'html';
  if (typeof formatOrOptions === 'object' && formatOrOptions?.parse_mode === 'HTML') return 'html';
  return 'markdown';
}

export interface EmbedDelivery {
  kind?: 'message' | 'notice' | 'error';
  role?: 'assistant' | 'system';
  format?: 'markdown' | 'html';
  turnId?: string;
}

/**
 * Append to the outbox and notify live listeners. Returns the assigned sequence,
 * or 0 when the chat has no thread row (nothing can read it, so nothing is
 * written — same silent no-op the registry applies to unrouted chatIds).
 */
export async function deliverToEmbedChat(
  chatId: string,
  text: string,
  delivery: EmbedDelivery = {},
): Promise<number> {
  const seq = await pushEmbedOutbox(chatId, {
    kind: delivery.kind ?? 'message',
    role: delivery.role ?? 'assistant',
    content: text,
    format: delivery.format ?? 'markdown',
    turnId: delivery.turnId,
  });
  if (seq === 0) return 0;

  const event: EmbedOutboxEvent = {
    chatId,
    seq,
    kind: delivery.kind ?? 'message',
    role: delivery.role ?? 'assistant',
    content: text,
    format: delivery.format ?? 'markdown',
    turnId: delivery.turnId,
    createdAt: new Date().toISOString(),
  };
  logBus.emit('embed', event);
  return seq;
}

/** ChannelSender registered for the `embed:` prefix. */
export async function sendEmbedToChat(
  chatId: string,
  text: string,
  formatOrOptions?: ChannelSendFormat,
  throwOnError = false,
): Promise<void> {
  if (!isEmbedChatId(chatId)) return;
  try {
    await deliverToEmbedChat(chatId, text, { format: formatOf(formatOrOptions) });
  } catch (err) {
    console.error(`[embed] Failed to enqueue outbound message for ${chatId}:`, err);
    if (throwOnError) throw err;
  }
}

/** Idempotent registration; called from setupEmbedChannel(). */
export function registerEmbedSender(): void {
  registerChannelSender(EMBED_CHAT_PREFIX, sendEmbedToChat);
}
