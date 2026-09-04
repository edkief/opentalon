import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { threads, type Thread } from '../db/schema';
import type { ResolvedThread } from './types';

/**
 * Thread row persistence.
 *
 * There is deliberately no FK from the `thread_id` columns to `threads.id`
 * (#43): `addMessage` swallows its own errors on four hot paths, so an FK would
 * turn a missing thread row into silent history loss. Writers call
 * `ensureThread` first instead, and a failed ensure costs a picker entry rather
 * than a message.
 *
 * Uniqueness comes from the id being a deterministic function of the natural
 * key — the same discipline `email:<hash>` already uses — so creation is an
 * upsert on the primary key, not a unique index over derived columns.
 */

interface ThreadCache {
  // Thread rows by id. #46 resolves a route on every outbound send, so the read
  // path is hot; writers here keep it coherent rather than invalidating blindly.
  rows: Map<string, Thread>;
}

// Survives HMR in dev, same pattern as src/lib/channels/registry.ts:42.
function getCache(): ThreadCache {
  const g = globalThis as typeof globalThis & { __threadCache?: ThreadCache };
  if (!g.__threadCache) {
    g.__threadCache = { rows: new Map() };
  }
  return g.__threadCache;
}

/**
 * Upsert the thread row for a resolved thread and mark it active.
 *
 * Called by every inbound path before its first write. Non-fatal by design: a
 * thread row is bookkeeping for the picker and for routing in #46, and must
 * never block the message it describes from being stored.
 */
export async function ensureThread(resolved: ResolvedThread): Promise<void> {
  const { threadId, chatId, channel, route, title } = resolved;
  const now = new Date();
  try {
    const [row] = await db
      .insert(threads)
      .values({
        id: threadId,
        chatId,
        channel,
        ...(route !== undefined && { route }),
        ...(title !== undefined && { title }),
        origin: 'inbound',
        lastActivityAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: threads.id,
        set: {
          lastActivityAt: now,
          updatedAt: now,
          // Only overwrite a title the channel actually supplied — an email
          // subject or topic name shouldn't be blanked by a later message that
          // doesn't carry one.
          ...(title !== undefined && { title }),
          ...(route !== undefined && { route }),
        },
      })
      .returning();
    if (row) getCache().rows.set(threadId, row);
  } catch (error) {
    console.error('[threads] Failed to ensure thread:', error);
  }
}

/** Fetch a thread row, or null if it doesn't exist. */
export async function getThread(threadId: string): Promise<Thread | null> {
  const cached = getCache().rows.get(threadId);
  if (cached) return cached;
  try {
    const rows = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    if (rows[0]) getCache().rows.set(threadId, rows[0]);
    return rows[0] ?? null;
  } catch (error) {
    console.error('[threads] Failed to load thread:', error);
    return null;
  }
}

/** Bump `last_activity_at` without touching the rest of the row. */
export async function touchThread(threadId: string): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(threads)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(threads.id, threadId));
    const cached = getCache().rows.get(threadId);
    if (cached) cached.lastActivityAt = now;
  } catch (error) {
    console.error('[threads] Failed to touch thread:', error);
  }
}

/** Threads on a chat, most recently active first. Powers the picker in #47. */
export async function listThreadsForChat(
  chatId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Thread[]> {
  try {
    const where = opts.includeArchived
      ? eq(threads.chatId, chatId)
      : and(eq(threads.chatId, chatId), eq(threads.status, 'active'));
    return await db.select().from(threads).where(where).orderBy(desc(threads.lastActivityAt));
  } catch (error) {
    console.error('[threads] Failed to list threads:', error);
    return [];
  }
}

/**
 * Mark a thread archived. Thread-level only — `conversations.active` is what
 * `/reset` sets and what history reads filter on, and is left alone here.
 */
export async function archiveThread(threadId: string): Promise<void> {
  try {
    await db
      .update(threads)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(threads.id, threadId));
    getCache().rows.delete(threadId);
  } catch (error) {
    console.error('[threads] Failed to archive thread:', error);
  }
}

/**
 * Mint a new dashboard thread on a chat. Unlike the inbound channels the
 * dashboard has no natural key to derive an id from, so ids are random and the
 * caller persists the returned id.
 */
export async function createDashboardThread(
  chatId: string,
  title?: string,
): Promise<string> {
  const threadId = `web:${crypto.randomUUID()}`;
  const now = new Date();
  const [row] = await db.insert(threads).values({
    id: threadId,
    chatId,
    channel: 'web',
    ...(title !== undefined && { title }),
    origin: 'dashboard',
    lastActivityAt: now,
    updatedAt: now,
  }).returning();
  if (row) getCache().rows.set(threadId, row);
  return threadId;
}
