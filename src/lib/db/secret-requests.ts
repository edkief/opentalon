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
  status: 'fulfilled' | 'declined',
): Promise<SecretRequest | null> {
  const rows = await db
    .update(secretRequests)
    .set({ status })
    .where(eq(secretRequests.id, id))
    .returning();
  return rows[0] ?? null;
}
