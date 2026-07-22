import { eq } from 'drizzle-orm';
import { db } from './index';
import { secretRequests } from './schema';
import type { SecretRequest } from './schema';

export async function createSecretRequest(
  id: string,
  name: string,
  reason: string,
  chatId: string,
  ttlMinutes = 15,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await db.insert(secretRequests).values({ id, name, reason, chatId, expiresAt });
}

export async function getSecretRequest(id: string): Promise<SecretRequest | null> {
  const rows = await db.select().from(secretRequests).where(eq(secretRequests.id, id));
  return rows[0] ?? null;
}

export async function markSecretRequest(
  id: string,
  status: 'fulfilled' | 'declined' | 'guided',
  value?: string,
): Promise<SecretRequest | null> {
  const rows = await db
    .update(secretRequests)
    .set({ status, value: value ?? null })
    .where(eq(secretRequests.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Null out the transient `value` once the polling tool has read it. Keeps a raw
 * secret's at-rest lifetime bounded to a single poll interval rather than the
 * row's 15-minute TTL. Status is left intact so the request stays auditable.
 */
export async function clearSecretValue(id: string): Promise<void> {
  await db
    .update(secretRequests)
    .set({ value: null })
    .where(eq(secretRequests.id, id));
}

/** Mark a still-pending secret request as expired (poll-loop timeout / TTL). */
export async function expireSecretRequest(id: string): Promise<void> {
  await db
    .update(secretRequests)
    .set({ status: 'expired' })
    .where(eq(secretRequests.id, id));
}
