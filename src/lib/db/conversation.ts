import { randomUUID } from 'node:crypto';
import { db } from './index';
import { conversations, type NewConversation } from './schema';
import { and, count, desc, eq } from 'drizzle-orm';
import { emitConversationMessage } from '../agent/log-bus';

export async function addMessage(
  chatId: string,
  messageId: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  agentId: string,
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    model?: string;
  },
  turnId?: string,
  // The turn's AI SDK response.messages (tool-call/result parts), replayed
  // into the prompt on later turns. See src/lib/agent/turn-parts.ts.
  parts?: unknown[],
): Promise<void> {
  try {
    const message: NewConversation = {
      chatId,
      messageId,
      role,
      content,
      agentId,
      ...(turnId !== undefined && { turnId }),
      ...(parts !== undefined && { parts }),
      ...(tokens?.inputTokens !== undefined && { inputTokens: tokens.inputTokens }),
      ...(tokens?.outputTokens !== undefined && { outputTokens: tokens.outputTokens }),
      ...(tokens?.cacheReadTokens !== undefined && { cacheReadTokens: tokens.cacheReadTokens }),
      ...(tokens?.cacheWriteTokens !== undefined && { cacheWriteTokens: tokens.cacheWriteTokens }),
      ...(tokens?.reasoningTokens !== undefined && { reasoningTokens: tokens.reasoningTokens }),
      ...(tokens?.model !== undefined && { model: tokens.model }),
    };
    const [inserted] = await db
      .insert(conversations)
      .values(message)
      .returning({ id: conversations.id, createdAt: conversations.createdAt });

    if (inserted) {
      emitConversationMessage({
        id: randomUUID(),
        rowId: inserted.id,
        chatId,
        agentId,
        messageId,
        role,
        content,
        createdAt: inserted.createdAt.toISOString(),
        turnId,
      });
    }
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
          eq(conversations.active, true),
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

// Reset archives rows (active = false) rather than deleting them: the agent
// stops loading them as context, but the data stays in the DB for
// analytics/troubleshooting and the Thought Stream history.
export async function clearConversationForAgent(chatId: string, agentId: string): Promise<void> {
  try {
    await db
      .update(conversations)
      .set({ active: false })
      .where(
        and(
          eq(conversations.chatId, chatId),
          eq(conversations.agentId, agentId),
          eq(conversations.active, true),
        ),
      );
  } catch (error) {
    console.error('[DB] Failed to clear conversation:', error);
  }
}

export async function clearConversation(chatId: string): Promise<void> {
  try {
    await db
      .update(conversations)
      .set({ active: false })
      .where(and(eq(conversations.chatId, chatId), eq(conversations.active, true)));
  } catch (error) {
    console.error('[DB] Failed to clear conversation for chat:', error);
  }
}

export interface LastTurnContextSize {
  /**
   * Provider-reported input tokens for the last completed turn (the total the
   * model actually saw — system prompt + history + RAG + tools). Same source
   * `/compact` reports as `beforeTokens`. `null` when no turn has been recorded
   * yet (e.g. brand-new chat) — callers should fall back to a local estimate.
   */
  tokens: number | null;
  /** Number of active history rows currently in the conversation. */
  messageCount: number;
}

/**
 * Look up the most recent assistant row's `inputTokens` plus the active row
 * count for a chat/agent pair. Used by `/status` to show the current context
 * size — consistent with `/compact`, which reads the same `inputTokens` field
 * (`src/lib/agent/compactor.ts:139`).
 *
 * Two cheap queries in parallel; bounded by the `chat_agent_created_idx`
 * composite index on `conversations`.
 */
export async function getLastTurnContextSize(
  chatId: string,
  agentId: string,
): Promise<LastTurnContextSize> {
  try {
    const [lastRow, countRow] = await Promise.all([
      db
        .select({ inputTokens: conversations.inputTokens })
        .from(conversations)
        .where(
          and(
            eq(conversations.chatId, chatId),
            eq(conversations.agentId, agentId),
            eq(conversations.role, 'assistant'),
            eq(conversations.active, true),
          ),
        )
        .orderBy(desc(conversations.createdAt))
        .limit(1),
      db
        .select({ value: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.chatId, chatId),
            eq(conversations.agentId, agentId),
            eq(conversations.active, true),
          ),
        ),
    ]);

    return {
      tokens: lastRow[0]?.inputTokens ?? null,
      messageCount: Number(countRow[0]?.value ?? 0),
    };
  } catch (error) {
    console.error('[DB] Failed to get last turn context size:', error);
    return { tokens: null, messageCount: 0 };
  }
}
