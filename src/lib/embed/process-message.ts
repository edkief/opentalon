/**
 * The embed-channel turn runner.
 *
 * Mirrors src/lib/email/process-inbound.ts:207-296 (the cleanest copy of the
 * shape every channel repeats). Two things are specific here:
 *
 *  1. It is enqueued, not awaited. The route returns 202 immediately and the
 *     turn runs on, delivering into the outbox — an agent turn with tools
 *     routinely outlives an HTTP request, and the durable outbox means the
 *     client can disconnect and still collect the reply.
 *  2. Turns are serialized per chat via the process-wide queue in
 *     src/lib/concurrency/turn-queue.ts, so a user double-sending cannot
 *     interleave two turns over the same history. Different chats run in
 *     parallel.
 *
 * Crash recovery is deliberately NOT wired: recordPendingTurn exists, but
 * recoverPendingTurns (src/lib/telegram/resume-turn.ts) hardcodes a Telegram
 * context string and only runs inside the long-polling branch, so recording here
 * would resume embed turns with the wrong prompt. Generalising resume-turn.ts is
 * the follow-up.
 */

import { llmExecutor } from '../agent';
import { isChatText, type Message } from '../agent/types';
import { buildTurnParts } from '../agent/turn-parts';
import { extractUsage } from '../agent/usage';
import { addMessage, getConversationHistory } from '../db';
import { getEmbedThread } from '../db/embed';
import { getSkillsSummary, getWorkspaceDir } from '../tools';
import { schedulerService } from '../scheduler';
import { sendToChat } from '../channels/registry';
import { enqueueForTurn } from '../concurrency/turn-queue';
import { deliverToEmbedChat } from './send';
import { buildEmbedTools, resolveEmbedAgent } from './tools';
import { renderContextBlock, type EmbedResourceContext } from './context';
import { getEmbedConfig, type ResolvedEmbedClient } from './config';

export interface EmbedTurnRequest {
  chatId: string;
  client: ResolvedEmbedClient;
  message: string;
  turnId: string;
  /** Host-asserted display name, used only to label the message in history. */
  userLabel?: string;
}

/** Queue a turn. Returns immediately; the reply lands in the outbox. */
export function enqueueEmbedTurn(req: EmbedTurnRequest): void {
  enqueueForTurn(req.chatId, () => runEmbedTurn(req));
}

async function runEmbedTurn(req: EmbedTurnRequest): Promise<void> {
  const { chatId, client, message, turnId } = req;
  const channelCfg = getEmbedConfig();
  if (!channelCfg) {
    console.warn(`[embed] Dropping turn for ${chatId}: channel disabled mid-flight`);
    return;
  }

  const thread = await getEmbedThread(chatId);
  if (!thread) {
    console.warn(`[embed] Dropping turn for ${chatId}: no thread row`);
    return;
  }

  const agentId = await resolveEmbedAgent(chatId, client);
  const scope = client.memoryScope;
  const turnJobIds = new Set<string>();

  const [tools, history, skillsSummary] = await Promise.all([
    buildEmbedTools(chatId, client, agentId, scope, turnJobIds, turnId),
    getConversationHistory(chatId, agentId, channelCfg.historyLimit),
    getSkillsSummary(),
  ]);

  const messages: Message[] = [
    ...history.map((m) => ({
      role: m.role as Message['role'],
      content: m.content,
      ...(m.parts ? { parts: m.parts as Message['parts'] } : {}),
    })),
    { role: 'user', content: message },
  ];

  // Persist the user message before the LLM runs so the chat shows up in the
  // dashboard immediately, even if the turn then fails.
  await addMessage(chatId, chatId, 0, 'user', message, agentId, undefined, turnId).catch((err) =>
    console.error('[embed] Failed to store user message:', err),
  );

  const skillsContext = skillsSummary
    ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
    : '\n\nNo skills saved yet.';

  const context = renderContextBlock({
    chatId,
    clientLabel: client.label,
    resourceId: thread.resourceId,
    title: thread.title,
    url: thread.url,
    context: (thread.context as EmbedResourceContext | null) ?? null,
    contextVersion: thread.contextVersion,
    maxChars: client.maxContextChars,
    workspaceDir: getWorkspaceDir(),
    skillsContext,
  });

  try {
    const response = await llmExecutor.chat({
      messages,
      context,
      memoryScope: scope,
      chatId,
      tools,
      agentId,
      turnJobIds,
      turnId,
      userInitiated: true,
    });

    if (!isChatText(response)) {
      await deliverToEmbedChat(chatId, "I couldn't produce a reply just then — try again in a moment.", {
        kind: 'error',
        role: 'system',
        turnId,
      });
      console.error(`[embed] Turn produced a non-text response (chat ${chatId})`);
      return;
    }

    // A tool-only turn still has to say something, same as the other channels.
    const replyText = response.text.trim() || '✅ Done.';
    await sendToChat(chatId, replyText, 'markdown');
    console.log(`[embed] Replied on ${chatId} (turn ${turnId})`);

    addMessage(
      chatId,
      chatId,
      0,
      'assistant',
      replyText,
      agentId,
      {
        ...extractUsage(response.result?.totalUsage ?? response.result?.usage),
        model: response.provider,
      },
      response.turnId ?? turnId,
      buildTurnParts(response.responseMessages),
    ).catch((err) => console.error('[embed] Failed to store assistant message:', err));

    // Async history gist indexing — out of the response path.
    schedulerService
      .sendHistoryGistJob({ turnId: response.turnId ?? turnId, scope })
      .catch((err) => console.error('[History] Failed to enqueue gist job:', err));
  } catch (err) {
    console.error(`[embed] Turn failed (chat ${chatId}):`, err);
    await deliverToEmbedChat(chatId, '⚠️ Something went wrong handling that. Please try again.', {
      kind: 'error',
      role: 'system',
      turnId,
    }).catch(() => {});
  }
}
