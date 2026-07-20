import type { Context } from 'grammy';
import { llmExecutor } from '../agent';
import { schedulerService } from '../scheduler';
import { addMessage, getConversationHistory, getActiveAgent } from '../db';
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
 * A "From:" line identifying the sender, prepended to the message text so the
 * agent knows who is talking — essential in group chats where several people
 * share one chat_id. Mirrors the email channel's `From: ${fromAddress}` prefix.
 */
function senderPrefix(from: NonNullable<Context['message']>['from']): string {
  if (!from) return '';
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  const handle = from.username ? `@${from.username}` : '';
  const label = [displayName, handle].filter(Boolean).join(' ');
  return `From: ${label ? `${label} ` : ''}(id: ${from.id})`;
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

  ctx.react('👀').catch(() => {});
  ctx.replyWithChatAction('typing').catch(() => {});
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  // User messages are always processed immediately — never queued behind background
  // job callbacks. The chatQueues map is used exclusively for serialising callbacks.
  try {
    const turnJobIds = new Set<string>();
    // One turn id groups the user message, intermediate steps, the reply, and
    // any specialists spawned along the way. Generated before tool building so
    // spawn_specialist can stamp it onto specialist runs.
    const turnId = crypto.randomUUID();
    const [tools, history, skillsSummary, activeAgent] = await Promise.all([
      buildTools(ctx, chatId, scope, turnJobIds, turnId),
      (async () => {
        const activeAgentId = await getActiveAgent(chatId);
        return getConversationHistory(chatId, activeAgentId, 20);
      })(),
      getSkillsSummary(),
      getActiveAgent(chatId),
    ]);

    // Prefix the sender identity so the agent knows who sent this — crucial in
    // groups. Only the message shown to the LLM/stored carries it; memory
    // ingestion below keeps the raw text.
    const prefix = senderPrefix(message?.from);
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

    await replyChunked(ctx, replyText);

    // Persist assistant reply to DB (fire and forget)
    addMessage(chatId, messageId, 'assistant', replyText, activeAgent, {
      ...extractUsage(response.result?.usage),
      model: response.provider,
    }, response.turnId ?? turnId, buildTurnParts(response.responseMessages)).catch(err => {
      console.error('[DB] Failed to store assistant message:', err);
    });

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
  }
}
