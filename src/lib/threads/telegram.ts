import type { Chat, Message } from 'grammy/types';
import type { ResolvedThread } from './types';

/**
 * Resolve the thread a Telegram message belongs to.
 *
 * For now every message resolves to its chat's root thread — `threadId ===
 * chatId` verbatim — which is exactly today's behaviour and keeps this ticket's
 * "no user-visible change" guarantee.
 *
 * Reading `message_thread_id` so that each forum topic becomes its own thread
 * is #46 (T5), behind the `telegram.forumTopics` flag. It lands there rather
 * than here because a topic producer is untestable until every outbound send
 * path echoes the topic id back — a missed send call site silently posts into
 * the forum's General topic.
 */
export function telegramThread(chat: Chat, _message?: Message): ResolvedThread {
  const chatId = String(chat.id);
  return { threadId: chatId, chatId, channel: 'telegram' };
}
