import { db } from './index';
import { conversations, type NewConversation } from './schema';
import { and, desc, eq } from 'drizzle-orm';

const MAX_MESSAGES = 10;

export async function addMessage(
  chatId: string,
  messageId: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  agentId: string,
  tokens?: { inputTokens?: number; outputTokens?: number; model?: string },
): Promise<void> {
  try {
    const message: NewConversation = {
      chatId,
      messageId,
      role,
      content,
      agentId,
      ...(tokens?.inputTokens !== undefined && { inputTokens: tokens.inputTokens }),
      ...(tokens?.outputTokens !== undefined && { outputTokens: tokens.outputTokens }),
      ...(tokens?.model !== undefined && { model: tokens.model }),
    };
    await db.insert(conversations).values(message);
  } catch (error) {
    console.error('[DB] Failed to add message:', error);
  }
}

export async function getConversationHistory(
  chatId: string,
  agentId: string,
  limit: number = 5,
): Promise<NewConversation[]> {
  try {
    const messages = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.chatId, chatId),
          eq(conversations.agentId, agentId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(limit);

    // Return in chronological order (oldest first)
    return messages.reverse();
  } catch (error) {
    console.error('[DB] Failed to get conversation history:', error);
    return [];
  }
}

export async function clearConversationForAgent(chatId: string, agentId: string): Promise<void> {
  try {
    await db
      .delete(conversations)
      .where(
        and(
          eq(conversations.chatId, chatId),
          eq(conversations.agentId, agentId),
        ),
      );
  } catch (error) {
    console.error('[DB] Failed to clear conversation:', error);
  }
}

export async function clearConversation(chatId: string): Promise<void> {
  try {
    await db.delete(conversations).where(eq(conversations.chatId, chatId));
  } catch (error) {
    console.error('[DB] Failed to clear conversation for chat:', error);
  }
}
