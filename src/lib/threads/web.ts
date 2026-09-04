import type { ResolvedThread } from './types';

/** Chat id the dashboard falls back to when a request names none. */
export const WEB_CHAT_ID = 'web';

/**
 * Resolve the thread for a dashboard/web-API request.
 *
 * Falls back to the request's own chatId rather than a literal `'web'`. The
 * epic's framing (#41) assumed the dashboard was a single hardcoded `'web'`
 * conversation, but `src/app/api/chat/route.ts` already accepts a chatId from
 * the request body, so a literal fallback would merge every existing dashboard
 * transcript into one thread the moment reads flip in #45. Falling back to the
 * chatId is the epic's own root-thread rule (`threadId === chatId`), and leaves
 * a request that names neither on `'web'` — the historical id.
 */
export function webThread(threadId?: string | null, chatId?: string | null): ResolvedThread {
  const resolvedChatId = chatId?.trim() || WEB_CHAT_ID;
  return {
    threadId: threadId?.trim() || resolvedChatId,
    chatId: resolvedChatId,
    channel: 'web',
  };
}
