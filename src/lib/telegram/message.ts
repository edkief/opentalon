import type { Context } from 'grammy';
import { llmExecutor } from '../agent';
import { ingestMemory } from '../memory';
import { addMessage, getConversationHistory, getActiveAgent } from '../db';
import { getWorkspaceDir, getSkillsSummary } from '../tools';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import { escapeHtml } from './format';
import { replyChunked } from './send';
import { chatModelPins, getScope, isOwner } from './state';
import { buildTools } from './tools';

const FALLBACK_ERROR_MESSAGE = "My brain is a bit foggy right now, give me a second...";

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
  const scope = getScope(chat.type);


  ctx.react('👀').catch(() => {});
  ctx.replyWithChatAction('typing').catch(() => {});
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  // User messages are always processed immediately — never queued behind background
  // job callbacks. The chatQueues map is used exclusively for serialising callbacks.
  try {
    const turnJobIds = new Set<string>();
    const [tools, history, skillsSummary, activeAgent] = await Promise.all([
      buildTools(ctx, chatId, scope, turnJobIds),
      (async () => {
        const activeAgentId = await getActiveAgent(chatId);
        return getConversationHistory(chatId, activeAgentId, 20);
      })(),
      getSkillsSummary(),
      getActiveAgent(chatId),
    ]);

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: text },
    ];

    // One turn id groups the user message, intermediate steps, and the reply.
    const turnId = crypto.randomUUID();

    // Save user message before LLM runs so the chat appears in the dashboard immediately
    await addMessage(chatId, messageId, 'user', text, activeAgent, undefined, turnId).catch(err => {
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
    });

    if (!isChatText(response)) {
      await ctx.reply(FALLBACK_ERROR_MESSAGE);
      return;
    }

    const replyText = response.text.trim();
    if (!replyText) {
      // Agent finished via tool calls without generating a text summary
      await ctx.reply('✅ Done.');
      return;
    }

    await replyChunked(ctx, replyText);

    // Persist assistant reply to DB (fire and forget)
    addMessage(chatId, messageId, 'assistant', replyText, activeAgent, {
      inputTokens: response.result?.usage?.inputTokens,
      outputTokens: response.result?.usage?.outputTokens,
      model: response.provider,
    }, response.turnId ?? turnId).catch(err => {
      console.error('[DB] Failed to store assistant message:', err);
    });

    // Store messages in memory (fire and forget)
    ingestMemory({ chatId, scope, author: 'user', text, agent: activeAgent }).catch(err => {
      console.error('[Memory] Failed to store user message:', err);
    });

    ingestMemory({ chatId, scope, author: 'exchange', text: `User: ${text}\nAssistant: ${replyText}`, agent: activeAgent }).catch(err => {
      console.error('[Memory] Failed to store exchange:', err);
    });
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
