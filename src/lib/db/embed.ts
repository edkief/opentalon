/**
 * Embed-channel persistence: conversation threads, inbound idempotency, and the
 * durable outbox.
 *
 * Every function here is chat-scoped. Callers must pass a chatId derived from an
 * authenticated principal (src/lib/embed/threads.ts) — never one taken from a
 * request body — since these queries are the only thing standing between one
 * host user's conversation and another's.
 */

import { and, asc, count, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from './index';
import { embedInbound, embedOutbox, embedThreads } from './schema';
import type { EmbedOutboxRow, EmbedThread, NewEmbedThread } from './schema';

// ─── Threads ─────────────────────────────────────────────────────────────────

export async function getEmbedThread(chatId: string): Promise<EmbedThread | null> {
  const [row] = await db.select().from(embedThreads).where(eq(embedThreads.chatId, chatId)).limit(1);
  return row ?? null;
}

/**
 * Create the thread on first contact, refresh its mutable descriptors after.
 *
 * `context`/`contextVersion` are only overwritten when the caller supplies a
 * context — a plain message POST carrying no envelope must not wipe the context
 * a previous /context call established.
 */
export async function upsertEmbedThread(row: NewEmbedThread): Promise<void> {
  const set: Partial<NewEmbedThread> = {
    resourceId: row.resourceId,
    userLabel: row.userLabel,
    title: row.title,
    url: row.url,
    updatedAt: new Date(),
  };
  if (row.context !== undefined) {
    set.context = row.context;
    set.contextVersion = row.contextVersion;
  }

  await db
    .insert(embedThreads)
    .values(row)
    .onConflictDoUpdate({ target: embedThreads.chatId, set });
}

/** Replace the page-context envelope. Returns the version actually stored. */
export async function updateEmbedThreadContext(
  chatId: string,
  context: Record<string, unknown> | null,
  contextVersion: string | null,
): Promise<void> {
  await db
    .update(embedThreads)
    .set({ context, contextVersion, updatedAt: new Date() })
    .where(eq(embedThreads.chatId, chatId));
}

/** Thread count per client, for the dashboard status card. */
export async function countEmbedThreadsByClient(clientId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(embedThreads)
    .where(eq(embedThreads.clientId, clientId));
  return Number(row?.n ?? 0);
}

/** Display title for an embed chatId, used by /api/chats. */
export async function getEmbedChatTitle(chatId: string): Promise<string | null> {
  const [row] = await db
    .select({ title: embedThreads.title, resourceId: embedThreads.resourceId })
    .from(embedThreads)
    .where(eq(embedThreads.chatId, chatId))
    .limit(1);
  if (!row) return null;
  return row.title?.trim() || row.resourceId;
}

// ─── Inbound idempotency ─────────────────────────────────────────────────────

/**
 * Claim a (chatId, clientMessageId) pair. `fresh: false` means the host is
 * retrying a message we already accepted — the caller must NOT run a second turn
 * and should return the original turnId.
 */
export async function claimEmbedInbound(
  chatId: string,
  clientMessageId: string,
  turnId: string,
): Promise<{ fresh: boolean; turnId: string }> {
  const inserted = await db
    .insert(embedInbound)
    .values({ chatId, clientMessageId, turnId })
    .onConflictDoNothing({ target: [embedInbound.chatId, embedInbound.clientMessageId] })
    .returning({ turnId: embedInbound.turnId });

  if (inserted.length > 0) return { fresh: true, turnId };

  const [existing] = await db
    .select({ turnId: embedInbound.turnId })
    .from(embedInbound)
    .where(
      and(eq(embedInbound.chatId, chatId), eq(embedInbound.clientMessageId, clientMessageId)),
    )
    .limit(1);
  return { fresh: false, turnId: existing?.turnId ?? turnId };
}

// ─── Outbox ──────────────────────────────────────────────────────────────────

export interface OutboxPush {
  kind?: 'message' | 'notice' | 'error';
  role?: 'assistant' | 'system';
  content: string;
  format?: 'markdown' | 'html';
  turnId?: string;
}

/**
 * Append to a chat's outbox and return the assigned sequence number.
 *
 * The sequence is allocated atomically from `embed_threads.lastSeq` rather than
 * from a global serial (which can commit out of order, leaving a row behind a
 * cursor the client already passed) or from max(seq) over the outbox itself
 * (which would restart numbering once retention sweeps an idle chat clean).
 *
 * Returns 0 without writing when no thread row exists — an outbox entry for a
 * chat nobody can authenticate to is unreachable, and silently dropping it
 * matches how `sendToChat` treats an unrouted chatId.
 */
export async function pushEmbedOutbox(chatId: string, msg: OutboxPush): Promise<number> {
  const [claimed] = await db
    .update(embedThreads)
    .set({ lastSeq: sql`${embedThreads.lastSeq} + 1` })
    .where(eq(embedThreads.chatId, chatId))
    .returning({ seq: embedThreads.lastSeq });

  if (!claimed) return 0;

  await db.insert(embedOutbox).values({
    chatId,
    seq: claimed.seq,
    kind: msg.kind ?? 'message',
    role: msg.role ?? 'assistant',
    content: msg.content,
    format: msg.format ?? 'markdown',
    turnId: msg.turnId,
  });

  return claimed.seq;
}

export async function readEmbedOutbox(
  chatId: string,
  sinceSeq: number,
  limit = 100,
): Promise<EmbedOutboxRow[]> {
  return db
    .select()
    .from(embedOutbox)
    .where(and(eq(embedOutbox.chatId, chatId), gt(embedOutbox.seq, sinceSeq)))
    .orderBy(asc(embedOutbox.seq))
    .limit(limit);
}

/** Current cursor for a chat — what a client should pass as `since` to get only new rows. */
export async function latestEmbedOutboxSeq(chatId: string): Promise<number> {
  const [row] = await db
    .select({ lastSeq: embedThreads.lastSeq })
    .from(embedThreads)
    .where(eq(embedThreads.chatId, chatId))
    .limit(1);
  return Number(row?.lastSeq ?? 0);
}

/** Total undelivered-window size across all chats, for the status card. */
export async function countEmbedOutbox(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(embedOutbox);
  return Number(row?.n ?? 0);
}

/**
 * Drop outbox rows older than the retention window. A client that reconnects
 * after this loses replay and resyncs from conversation history instead.
 * Sequence numbers are unaffected — they live on embed_threads.lastSeq, so a
 * fully-swept chat still numbers its next message above any outstanding cursor.
 */
export async function sweepEmbedOutbox(retentionHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  const deleted = await db
    .delete(embedOutbox)
    .where(lt(embedOutbox.createdAt, cutoff))
    .returning({ seq: embedOutbox.seq });
  return deleted.length;
}

/** Prune inbound idempotency keys on the same schedule as the outbox. */
export async function sweepEmbedInbound(retentionHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  const deleted = await db
    .delete(embedInbound)
    .where(lt(embedInbound.createdAt, cutoff))
    .returning({ chatId: embedInbound.chatId });
  return deleted.length;
}
