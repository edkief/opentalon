import { db } from './index';
import { userInputs } from './schema';
import { eq, and } from 'drizzle-orm';
import type { UserInput } from './schema';

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
  return db.select().from(userInputs).where(and(eq(userInputs.chatId, chatId), eq(userInputs.status, 'pending' as any)));
}

export async function resolveUserInput(id: string, response: string): Promise<boolean> {
  await db
    .update(userInputs)
    .set({ status: 'responded', response })
    .where(eq(userInputs.id, id));
  return true;
}

export async function expireUserInput(id: string): Promise<void> {
  await db
    .update(userInputs)
    .set({ status: 'expired' })
    .where(eq(userInputs.id, id));
}

export async function getOldPendingInputs(maxAgeMs = 300_000): Promise<UserInput[]> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return db
    .select()
    .from(userInputs)
    .where(and(eq(userInputs.status, 'pending' as any), eq(userInputs.createdAt, cutoff)));
}
