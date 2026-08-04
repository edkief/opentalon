import type { Context } from 'grammy';
import { llmExecutor } from '../agent';
import { schedulerService } from '../scheduler';
import { addMessage, getConversationHistory, getActiveAgent, recordPendingTurn, clearPendingTurn } from '../db';
import { configManager } from '../config';
import { getPendingUserInputsByChatId, resolveUserInput } from '../db/user-inputs';
import { getWorkspaceDir, getSkillsSummary } from '../tools';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import { buildTurnParts } from '../agent/turn-parts';
import { extractUsage } from '../agent/usage';
import { escapeHtml } from './format';
import { replyChunked } from './send';
import { chatModelPins, getScope, isOwner } from './state';
import { buildTools } from './tools';

const FALLBACK_ERROR_MESSAGE = "My brain is a bit foggy right now, give me a second...";

/**
 * A speaker annotation identifying who just sent this message, prepended to the
 * text so the agent can tell people apart in group chats where several users
 * share one chat_id. Deliberately not shaped like an email/forward header
 * (e.g. "From: ..."): models tend to read that as quoted third-party content
 * and start talking about "the user" instead of replying to them directly.
 * Only used in shared (group) scope — in a private DM there's no one to
 * disambiguate, so the annotation is dropped to avoid the same misreading.
 */
function senderPrefix(from: NonNullable<Context['message']>['from'] | undefined): string {
  if (!from) return '';
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  const handle = from.username ? `@${from.username}` : '';
  const label = [displayName, handle].filter(Boolean).join(' ');
  const who = label ? `${label} (id: ${from.id})` : `id: ${from.id}`;
  return `[Speaking now: ${who} — reply to them directly as "you"]`;
}

export async function handleMessage(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const message = 'message' in ctx ? ctx.message : undefined;
  const text = message?.text;

  if (!text || !chat) {
    return;
  }

  // Don't respond to commands
  if (text.startsWith('/')) {
    return;
  }

  // Only respond to the configured owner
  if (!isOwner(message?.from?.id)) {
    return;
  }

  // In groups: require a @mention or a reply to one of the bot's messages
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const me = ctx.me;
    const isMention = new RegExp(`@${me.username}`, 'i').test(text);
    const isReplyToBot = message?.reply_to_message?.from?.id === me.id;
    if (!isMention && !isReplyToBot) {
      return;
    }
  }

  const chatId = String(chat.id);
  const messageId = message?.message_id ?? 0;
  const scope = getScope(chat.type, chatId);

  // If a request_guidance call is blocked waiting on this chat, treat this
  // message as the answer rather than starting an unrelated new turn.
  const pendingGuidance = await getPendingUserInputsByChatId(chatId);
  if (pendingGuidance.length > 0) {
    const oldest = pendingGuidance.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    await resolveUserInput(oldest.id, text);
    await ctx.reply('👍 Got it, passing that along...');
    return;
  }

  const agentId = await getActiveAgent(chatId);
  await executeTurn(ctx, { chatId, messageId, from: message?.from, text, scope, agentId });
}

/** Everything a single agent turn needs, independent of how it was triggered. */
export interface TurnParams {
  chatId: string;
  messageId: number;
  from: NonNullable<Context['message']>['from'] | undefined;
  text: string;
  scope: ReturnType<typeof getScope>;
  /** Agent to run this turn as — the chat's active agent, or a one-off override. */
  agentId: string;
  /**
   * When set, the reply is prefixed to signal a non-active agent answered
   * (used for one-off `/agent <id> <request>` routing).
   */
  attributionLabel?: string;
  /**
   * When set (and different from agentId), a short breadcrumb of this turn is
   * written into that agent's thread so the chat's active agent stays coherent
   * about the one-off detour it didn't run.
   */
  breadcrumbAgentId?: string;
}

/**
 * Runs one LLM turn for a given agent. Split out from handleMessage so the
 * `/agent <id> <request>` command can route a single request to a chosen agent
 * without changing the chat's active agent.
 */
export async function executeTurn(ctx: Context, params: TurnParams): Promise<void> {
  const { chatId, messageId, from, text, scope, agentId: activeAgent, attributionLabel, breadcrumbAgentId } = params;

  ctx.react('👀').catch(() => {});
  ctx.replyWithChatAction('typing').catch(() => {});
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  // When crash recovery is on, a pending-turn record is written before the turn
  // runs and cleared in `finally`. Tracked out here so `finally` can see it
  // regardless of where inside the try the turn got to.
  const resumeEnabled = configManager.get().llm?.resumeTurnsOnRestart === true;
  let recordedTurnId: string | undefined;

  // User messages are always processed immediately — never queued behind background
  // job callbacks. The chatQueues map is used exclusively for serialising callbacks.
  try {
    const turnJobIds = new Set<string>();
    // One turn id groups the user message, intermediate steps, the reply, and
    // any specialists spawned along the way. Generated before tool building so
    // spawn_specialist can stamp it onto specialist runs.
    const turnId = crypto.randomUUID();
    const [tools, history, skillsSummary] = await Promise.all([
      buildTools(ctx, chatId, scope, turnJobIds, turnId, activeAgent),
      getConversationHistory(chatId, activeAgent, 20),
      getSkillsSummary(),
    ]);

    // Annotate the sender only in shared (group) chats, where several people
    // funnel through one chat_id and the agent needs to tell them apart. In a
    // private DM it's always the same person, so we skip it — the annotation
    // otherwise reads like a quoted header and nudges the model into
    // third-person ("if the user wants...") instead of talking to them.
    // Only the message shown to the LLM/stored carries it; memory ingestion
    // below keeps the raw text.
    const prefix = scope === 'shared' ? senderPrefix(from) : '';
    const userContent = prefix ? `${prefix}\n\n${text}` : text;

    const messages: Message[] = [
      ...history.map((m) => ({
        role: m.role as Message['role'],
        content: m.content,
        ...(m.parts ? { parts: m.parts as Message['parts'] } : {}),
      })),
      { role: 'user', content: userContent },
    ];

    // Save user message before LLM runs so the chat appears in the dashboard immediately
    await addMessage(chatId, messageId, 'user', userContent, activeAgent, undefined, turnId).catch(err => {
      console.error('[DB] Failed to store user message:', err);
    });

    // Crash recovery: record this turn as in-flight before the LLM runs. Cleared
    // in `finally` on completion (success or handled error); a row that outlives
    // the process marks a turn to resume on startup. The user message and its
    // steps (persisted as they complete) supply everything needed to replay it.
    if (resumeEnabled) {
      recordedTurnId = turnId;
      await recordPendingTurn({
        turnId,
        chatId,
        agentId: activeAgent,
        messageId,
        scope,
        userContent,
        modelOverride: chatModelPins.get(chatId) ?? null,
      });
    }

    const skillsContext = skillsSummary
      ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
      : '\n\nNo skills saved yet.';

    const response = await llmExecutor.chat({
      messages,
      context: `Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()} (use this as the base for all file paths). Skills are stored in ${getWorkspaceDir()}/skills/. Generated files (images, audio, etc.) should be saved to the workspace dir. Shell env vars available in run_command: TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN.${skillsContext}`,
      memoryScope: scope,
      chatId,
      tools,
      agentId: activeAgent,
      modelOverride: chatModelPins.get(chatId),
      turnJobIds,
      turnId,
      userInitiated: true,
    });

    if (!isChatText(response)) {
      await ctx.reply(FALLBACK_ERROR_MESSAGE);
      return;
    }

    // A tool-only turn with no text summary must still persist an assistant
    // row — otherwise history keeps a dangling user message and the next turn
    // re-does (or hallucinates) the work.
    const replyText = response.text.trim() || '✅ Done.';

    // One-off routing: signal which non-active agent produced this reply, since
    // the chat's active agent is unchanged and would otherwise be assumed.
    const outbound = attributionLabel ? `🤖 ${attributionLabel}:\n\n${replyText}` : replyText;
    await replyChunked(ctx, outbound);

    // Persist assistant reply to DB (fire and forget)
    addMessage(chatId, messageId, 'assistant', replyText, activeAgent, {
      ...extractUsage(response.result?.totalUsage ?? response.result?.usage),
      model: response.provider,
    }, response.turnId ?? turnId, buildTurnParts(response.responseMessages)).catch(err => {
      console.error('[DB] Failed to store assistant message:', err);
    });

    // Breadcrumb: record the one-off detour in the active agent's own thread so
    // it stays coherent about work it delegated but did not run itself.
    if (breadcrumbAgentId && breadcrumbAgentId !== activeAgent) {
      addMessage(
        chatId,
        messageId,
        'assistant',
        `[Delegated to agent "${activeAgent}"]\nRequest: ${text}\nResult: ${replyText}`,
        breadcrumbAgentId,
        undefined,
        turnId,
      ).catch(err => {
        console.error('[DB] Failed to store delegation breadcrumb:', err);
      });
    }

    // Async, out-of-band history gist indexing (#27) — never in the response path.
    schedulerService
      .sendHistoryGistJob({ turnId: response.turnId ?? turnId, scope })
      .catch(err => console.error('[History] Failed to enqueue gist job:', err));
  } catch (error) {
    console.error('[Telegram Handler] Error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('[Config]')) {
      await ctx.reply(`⚠️ Configuration error — check the dashboard to fix it.\n\n<code>${escapeHtml(msg)}</code>`, { parse_mode: 'HTML' });
    } else if (msg.startsWith('[LLM]')) {
      await ctx.reply(`⚠️ <b>All language models failed.</b>\n\n<pre>${escapeHtml(msg)}</pre>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(FALLBACK_ERROR_MESSAGE);
    }
  } finally {
    clearInterval(typingInterval);
    // Turn finished (delivered or errored out) — drop its recovery record so it
    // is not re-run on the next restart. Only a hard crash skips this.
    if (recordedTurnId) {
      await clearPendingTurn(recordedTurnId).catch(err =>
        console.error('[DB] Failed to clear pending turn:', err),
      );
    }
  }
}
