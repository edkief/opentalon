/**
 * Embed conversation identity.
 *
 * A chatId is always DERIVED from an authenticated principal, never taken from
 * the request. That is the whole isolation story for this channel: two host
 * users on the same page get different hashes, and a host cannot address a
 * conversation it did not open.
 *
 * Shape: `embed:<clientId>:<16-hex>` — the clientId stays in the clear so the
 * chats list, log lines and the channel-registry prefix match stay legible,
 * mirroring how email keeps its `email:` prefix over a sha256 seed
 * (src/lib/email/threading.ts:66).
 */

import { createHash } from 'crypto';

export const EMBED_CHAT_PREFIX = 'embed:';

/** True for any chatId owned by the embed channel. */
export function isEmbedChatId(chatId: string): boolean {
  return chatId.startsWith(EMBED_CHAT_PREFIX);
}

/**
 * Client id embedded in an embed chatId, or null when the id is not ours or is
 * malformed. Used by the outbound sender and the dashboard chats list.
 */
export function embedClientIdOf(chatId: string): string | null {
  if (!isEmbedChatId(chatId)) return null;
  const rest = chatId.slice(EMBED_CHAT_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

/**
 * Derive the conversation id for a (client, resource, user) triple.
 *
 * The user key must be stable across the host user's sessions — a host that
 * rotates it per login mints a fresh conversation every time and loses all
 * continuity. This is called out in the TalonPress brief.
 */
export function embedChatId(clientId: string, resourceId: string, userKey: string): string {
  const seed = `${clientId}|${resourceId}|${userKey}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  return `${EMBED_CHAT_PREFIX}${clientId}:${hash}`;
}
