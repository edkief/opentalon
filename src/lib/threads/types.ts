import type { ThreadRoute } from '../db/schema';

/**
 * Thread identity, separated from routing address (epic #41).
 *
 * `threadId` says *which conversation* — what history to load, which agent is
 * active, what a step belongs to. `chatId` says *where a reply goes*, and keeps
 * the shape `resolveSender` dispatches on (src/lib/channels/registry.ts:65).
 *
 * Id convention: the root thread of a chat is `threadId === chatId` verbatim.
 * Sub-threads suffix the chat id (`<chatId>:t<messageThreadId>` for a Telegram
 * forum topic, `web:<uuid>` for a dashboard conversation). Nothing may parse a
 * threadId to route — routing reads `threads.chat_id`.
 */

/**
 * Floor for genuinely context-free invocations — a workflow or tool run with no
 * conversation behind it. Deliberately NOT a per-chat fallback: a shared literal
 * used that way would merge unrelated chats into one transcript.
 */
export const DEFAULT_THREAD_ID = 'default';

export type ThreadChannel = 'telegram' | 'email' | 'embed' | 'web' | 'system';

export interface ResolvedThread {
  threadId: string;
  chatId: string;
  channel: ThreadChannel;
  /** Channel extras needed to deliver into a sub-address. Consumed in #46. */
  route?: ThreadRoute;
  /** Topic name / email subject / embed resource title, when the channel knows one. */
  title?: string;
}
