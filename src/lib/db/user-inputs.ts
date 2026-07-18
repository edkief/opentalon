import { db } from './index';
import { userInputs } from './schema';
import { eq, and, lt } from 'drizzle-orm';
import type { UserInput } from './schema';

// Must match the polling timeout in request_guidance (src/lib/tools/communication.ts),
// so a request that outlived its own poll loop (e.g. process restart, aborted run)
// is never mistaken for a still-live one.
export const GUIDANCE_TIMEOUT_MS = 300_000;

export async function createUserInput(
  data: { chatId: string; prompt: string; options?: string[] | null }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(userInputs).values({
    id,
    chatId: data.chatId,
    prompt: data.prompt,
    options: data.options ?? null,
    status: 'pending',
  });
  return id;
}

export async function getUserInput(id: string): Promise<UserInput | undefined> {
  const result = await db.select().from(userInputs).where(eq(userInputs.id, id)).limit(1);
  return result[0];
}

export async function getPendingUserInputsByChatId(chatId: string): Promise<UserInput[]> {
  const rows = await db
    .select()
    .from(userInputs)
    .where(and(eq(userInputs.chatId, chatId), eq(userInputs.status, 'pending')));

  const cutoff = Date.now() - GUIDANCE_TIMEOUT_MS;
  const fresh: UserInput[] = [];
  for (const row of rows) {
    if (row.createdAt.getTime() < cutoff) {
      // Orphaned from a request_guidance call whose in-process poll loop never
      // reached its own expireUserInput (e.g. process restart, aborted run).
      // Expire it here so it can't be mistaken for the answer to a later,
      // unrelated message.
      await expireUserInput(row.id);
    } else {
      fresh.push(row);
    }
  }
  return fresh;
}

export async function resolveUserInput(id: string, response: string): Promise<boolean> {
  await db
    .update(userInputs)
    .set({ status: 'responded', response })
    .where(eq(userInputs.id, id));
  return true;
}

/**
 * Mark a pending input as undeliverable (e.g. the channel send threw). The
 * request_guidance poll loop picks this up and returns the delivery error to
 * the agent immediately instead of waiting out the full timeout.
 */
export async function failUserInput(id: string, error: string): Promise<void> {
  await db
    .update(userInputs)
    .set({ status: 'failed', response: error })
    .where(and(eq(userInputs.id, id), eq(userInputs.status, 'pending')));
}

export async function expireUserInput(id: string): Promise<void> {
  await db
    .update(userInputs)
    .set({ status: 'expired' })
    .where(eq(userInputs.id, id));
}

export async function getOldPendingInputs(maxAgeMs = GUIDANCE_TIMEOUT_MS): Promise<UserInput[]> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return db
    .select()
    .from(userInputs)
    .where(and(eq(userInputs.status, 'pending'), lt(userInputs.createdAt, cutoff)));
}
