/**
 * Fresh-text extraction (pure).
 *
 * Strips quoted trails and signatures so the LLM (and the `mention` trigger
 * keyword check) only sees what the sender actually typed in THIS message.
 * Inline-reply diffing (interleaved responses) is explicitly out of scope for
 * v1 — see docs/EMAIL_CHANNEL.md "Deferred".
 */

import EmailReplyParser from 'email-reply-parser';

const parser = new EmailReplyParser();

/**
 * Extract the visible (non-quoted, non-signature) reply text. Falls back to the
 * full trimmed body when the parser yields nothing (e.g. a first message with
 * no quoted trail, or an unusual client the parser can't segment).
 */
export function extractFreshText(body: string | null | undefined): string {
  const full = (body ?? '').replace(/\r\n/g, '\n');
  if (!full.trim()) return '';
  try {
    const visible = parser.parseReply(full).trim();
    return visible || full.trim();
  } catch {
    return full.trim();
  }
}
