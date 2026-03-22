import { db } from './index';
import { agentState } from './schema';
import { eq } from 'drizzle-orm';

export async function getActiveAgent(chatId: string): Promise<string> {
  try {
    const rows = await db
      .select({ agentName: agentState.agentName })
      .from(agentState)
      .where(eq(agentState.chatId, chatId))
      .limit(1);
    return rows[0]?.agentName ?? 'default';
  } catch {
    return 'default';
  }
}

export async function setActiveAgent(chatId: string, agentName: string): Promise<void> {
  await db
    .insert(agentState)
    .values({ chatId, agentName, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: agentState.chatId,
      set: { agentName, updatedAt: new Date() },
    });
}

export async function getAllAgentStates(): Promise<Array<{ chatId: string; agentName: string }>> {
  try {
    const rows = await db
      .select({ chatId: agentState.chatId, agentName: agentState.agentName })
      .from(agentState);
    return rows;
  } catch {
    return [];
  }
}
