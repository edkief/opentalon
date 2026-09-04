import { db } from './index';
import { agentState } from './schema';
import { eq } from 'drizzle-orm';
import { agentRegistry } from '../soul';

export async function renameAgentInState(oldName: string, newName: string): Promise<void> {
  await db
    .update(agentState)
    .set({ agentName: newName, updatedAt: new Date() })
    .where(eq(agentState.agentName, oldName));
}

export async function getActiveAgent(chatId: string): Promise<string> {
  try {
    const rows = await db
      .select({ agentName: agentState.agentName })
      .from(agentState)
      .where(eq(agentState.chatId, chatId))
      .limit(1);
    return rows[0]?.agentName ?? agentRegistry.getDefaultAgent();
  } catch {
    return agentRegistry.getDefaultAgent();
  }
}

/**
 * Point a chat at an agent.
 *
 * `threadId` is stamped but not yet keyed on: the PK moves from chat_id to
 * thread_id in #45 (T4), so the conflict target stays chat_id here and reads
 * (getActiveAgent) are untouched. Root threads pass their chatId verbatim.
 */
export async function setActiveAgent(
  chatId: string,
  threadId: string,
  agentName: string,
): Promise<void> {
  await db
    .insert(agentState)
    .values({ chatId, threadId, agentName, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: agentState.chatId,
      set: { agentName, threadId, updatedAt: new Date() },
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
