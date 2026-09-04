import { randomUUID } from 'node:crypto';
import { db } from './index';
import { conversationSteps, conversations, type NewConversation } from './schema';
import { and, count, desc, eq } from 'drizzle-orm';
import { emitConversationMessage } from '../agent/log-bus';

export async function addMessage(
  chatId: string,
  // Conversation identity (threads.id), distinct from the routing chatId above.
  // Required rather than optional so the compiler enumerates every writer —
  // this ticket's whole review question is whether any were missed, and a
  // silently-omitted threadId only surfaces as lost history when reads flip in
  // #45. Root threads pass their chatId verbatim.
  threadId: string,
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
      threadId,
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
   * Provider-reported input tokens for the FINAL step of the last completed
   * turn — the size of the full context the model actually saw on its last
   * call (system prompt + history + RAG + tools). Same source `/compact`
   * reports as `beforeTokens` (a single LLM call, not a sum across steps).
   * `null` when no turn has been recorded yet — callers should fall back to a
   * local estimate.
   *
   * NOTE: we deliberately do NOT read `conversations.inputTokens` here. That
   * column holds `totalUsage.inputTokens` — the SUM of `inputTokens` across
   * every step of the turn (see `src/lib/agent/types.ts:113-128` and
   * `src/lib/telegram/message.ts:205-210`), which double-counts because each
   * step re-sends the growing context. The right source for "context size" is
   * a single step — specifically the final one — which lives in
   * `conversation_steps.inputTokens`.
   */
  tokens: number | null;
  /** Number of active history rows currently in the conversation. */
  messageCount: number;
}

/**
 * Look up the most recent step's `inputTokens` plus the active row count for
 * a chat/agent pair. Used by `/status` to show the current context size —
 * consistent with `/compact`, which reads `result.usage.inputTokens` from its
 * single LLM call (`src/lib/agent/compactor.ts:139`).
 *
 * Two cheap queries in parallel. `conversation_steps` is bounded by the
 * `chat_agent_created_idx` composite index; `conversations` by the same.
 */
export async function getLastTurnContextSize(
  chatId: string,
  agentId: string,
): Promise<LastTurnContextSize> {
  try {
    const [lastStep, countRow] = await Promise.all([
      db
        .select({ inputTokens: conversationSteps.inputTokens })
        .from(conversationSteps)
        .where(
          and(
            eq(conversationSteps.chatId, chatId),
            eq(conversationSteps.agentId, agentId),
          ),
        )
        .orderBy(desc(conversationSteps.createdAt))
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
      tokens: lastStep[0]?.inputTokens ?? null,
      messageCount: Number(countRow[0]?.value ?? 0),
    };
  } catch (error) {
    console.error('[DB] Failed to get last turn context size:', error);
    return { tokens: null, messageCount: 0 };
  }
}
