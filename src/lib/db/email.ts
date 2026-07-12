import { db } from './index';
import { emailMessages, emailSyncState } from './schema';
import type { EmailMessage, NewEmailMessage, EmailSyncState } from './schema';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import {
  normalizeMessageId,
  normalizeIds,
  referencedIds,
  rootMessageId,
  chatIdFromSeed,
  normalizeSubject,
  subjectIsReply,
} from '../email/threading';

/**
 * Insert an email message row. Primary dedup is the Message-Id PK — a duplicate
 * (e.g. the same UID re-fetched after a crash) is skipped via
 * onConflictDoNothing. Returns whether a new row was actually inserted.
 */
export async function recordEmailMessage(row: NewEmailMessage): Promise<boolean> {
  const normalized: NewEmailMessage = {
    ...row,
    messageId: normalizeMessageId(row.messageId),
    inReplyTo: row.inReplyTo ? normalizeMessageId(row.inReplyTo) : null,
    referencesIds: row.referencesIds ? normalizeIds(row.referencesIds) : null,
  };
  const inserted = await db
    .insert(emailMessages)
    .values(normalized)
    .onConflictDoNothing({ target: emailMessages.messageId })
    .returning({ messageId: emailMessages.messageId });
  return inserted.length > 0;
}

/** Whether a Message-Id has already been fully processed (LLM turn / passive store done). */
export async function isMessageProcessed(messageId: string): Promise<boolean> {
  const id = normalizeMessageId(messageId);
  if (!id) return false;
  const [row] = await db
    .select({ processed: emailMessages.processed })
    .from(emailMessages)
    .where(eq(emailMessages.messageId, id))
    .limit(1);
  return row?.processed === true;
}

/** Mark a Message-Id processed once its inbound pipeline finishes. */
export async function markEmailProcessed(messageId: string): Promise<void> {
  const id = normalizeMessageId(messageId);
  if (!id) return;
  await db.update(emailMessages).set({ processed: true }).where(eq(emailMessages.messageId, id));
}

/**
 * Find an existing chatId by any referenced Message-Id. A single query over
 * message_id / in_reply_to / references_ids — outbound rows are recorded too,
 * so replies to the agent (and mid-thread joins) resolve here.
 */
export async function findChatIdByMessageIds(ids: string[]): Promise<string | null> {
  const normalized = normalizeIds(ids);
  if (normalized.length === 0) return null;
  const rows = await db
    .select({ chatId: emailMessages.chatId, createdAt: emailMessages.createdAt })
    .from(emailMessages)
    .where(
      or(
        inArray(emailMessages.messageId, normalized),
        inArray(emailMessages.inReplyTo, normalized),
        // Array overlap: any of our referenced ids appears in a stored References chain.
        sql`${emailMessages.referencesIds} && ${normalized}::text[]`,
      ),
    )
    .orderBy(emailMessages.createdAt)
    .limit(1);
  return rows[0]?.chatId ?? null;
}

/**
 * Subject-fallback threading for broken clients that send no References/
 * In-Reply-To: reuse a chatId when a message with the same normalized subject
 * and the same participant was seen within `sinceDays`.
 */
export async function findChatIdBySubject(
  normalizedSubject: string,
  participant: string,
  sinceDays = 30,
): Promise<string | null> {
  if (!normalizedSubject) return null;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const addr = participant.trim().toLowerCase();
  const rows = await db
    .select({ chatId: emailMessages.chatId })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.normalizedSubject, normalizedSubject),
        gte(emailMessages.createdAt, since),
        sql`lower(${emailMessages.fromAddress}) = ${addr} OR ${addr} = ANY(${emailMessages.toAddresses})`,
      ),
    )
    .orderBy(desc(emailMessages.createdAt))
    .limit(1);
  return rows[0]?.chatId ?? null;
}

/** The most recent inbound message for a chatId — used to build reply recipients + threading headers. */
export async function getLatestInboundForChat(chatId: string): Promise<EmailMessage | undefined> {
  const [row] = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.chatId, chatId), eq(emailMessages.direction, 'inbound')))
    .orderBy(desc(emailMessages.createdAt))
    .limit(1);
  return row;
}

export async function getSyncState(mailbox: string): Promise<EmailSyncState | undefined> {
  const [row] = await db.select().from(emailSyncState).where(eq(emailSyncState.mailbox, mailbox)).limit(1);
  return row;
}

export async function setSyncState(mailbox: string, uidValidity: string, lastUid: number): Promise<void> {
  await db
    .insert(emailSyncState)
    .values({ mailbox, uidValidity, lastUid, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: emailSyncState.mailbox,
      set: { uidValidity, lastUid, updatedAt: new Date() },
    });
}

/**
 * Resolve the conversation chatId for an inbound message, composing the pure
 * threading logic with DB lookups (see docs/EMAIL_CHANNEL.md Phase 3):
 *
 *   1. Any referenced Message-Id already known → reuse that chatId.
 *   2. Header fallback: hash the thread root (References[0] / In-Reply-To).
 *   3. No header links + reply-style subject → subject fallback within 30 days.
 *   4. Otherwise (incl. a brand-new, non-"Re:" subject) → new thread from own id.
 */
export async function resolveChatId(input: {
  messageId: string;
  inReplyTo?: string | null;
  references?: Array<string | null | undefined> | null;
  subject?: string | null;
  fromAddress: string;
}): Promise<string> {
  const refs = referencedIds(input.inReplyTo, input.references);

  // 1. Known referenced id → reuse its thread.
  if (refs.length > 0) {
    const known = await findChatIdByMessageIds(refs);
    if (known) return known;
    // 2. Header fallback — deterministic hash of the thread root.
    return chatIdFromSeed(rootMessageId(input.messageId, input.inReplyTo, input.references));
  }

  // 3. No header links. A reply-style subject from a broken client may still
  //    belong to an existing thread; a brand-new subject always mints a new one.
  if (subjectIsReply(input.subject)) {
    const bySubject = await findChatIdBySubject(normalizeSubject(input.subject), input.fromAddress);
    if (bySubject) return bySubject;
  }

  // 4. New thread seeded from this message's own id.
  return chatIdFromSeed(input.messageId);
}
