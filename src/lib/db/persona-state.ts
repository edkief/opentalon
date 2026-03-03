import { db } from './index';
import { personaState } from './schema';
import { eq } from 'drizzle-orm';

export async function getActivePersona(chatId: string): Promise<string> {
  try {
    const rows = await db
      .select({ personaName: personaState.personaName })
      .from(personaState)
      .where(eq(personaState.chatId, chatId))
      .limit(1);
    return rows[0]?.personaName ?? 'default';
  } catch {
    return 'default';
  }
}

export async function setActivePersona(chatId: string, personaName: string): Promise<void> {
  await db
    .insert(personaState)
    .values({ chatId, personaName, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: personaState.chatId,
      set: { personaName, updatedAt: new Date() },
    });
}

export async function getAllPersonaStates(): Promise<Array<{ chatId: string; personaName: string }>> {
  try {
    const rows = await db
      .select({ chatId: personaState.chatId, personaName: personaState.personaName })
      .from(personaState);
    return rows;
  } catch {
    return [];
  }
}
