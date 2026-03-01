import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { baseAgent } from '../agent';
import { ingestMemory } from '../memory';
import { getRegisteredTools } from '../tools';
import { createSpawnSpecialistTool } from '../agent/specialist';
import { resolveApproval } from '../agent/hitl';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import type { MemoryScope } from '../memory';
import type { ToolSet } from 'ai';

const FALLBACK_ERROR_MESSAGE = "My brain is a bit foggy right now, give me a second...";

function getScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
}

async function buildTools(
  ctx: Context,
  chatId: string,
): Promise<ToolSet> {
  const sendApprovalRequest = async (
    approvalId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> => {
    const preview = JSON.stringify(input, null, 2).slice(0, 500);
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${approvalId}`)
      .text('❌ Deny', `deny:${approvalId}`);

    await ctx.reply(
      `⚠️ *Dangerous tool requested*\n\n*Tool:* \`${toolName}\`\n*Input:*\n\`\`\`json\n${preview}\n\`\`\`\n\nApprove this action?`,
      { parse_mode: 'Markdown', reply_markup: keyboard },
    );
  };

  const mcpTools = await getRegisteredTools({ sendApprovalRequest });
  const spawnSpecialist = createSpawnSpecialistTool(0, mcpTools);

  return { ...mcpTools, spawn_specialist: spawnSpecialist };
}

export async function handleStartCommand(ctx: Context): Promise<void> {
  await ctx.reply("Hello! I'm OpenPincer, your AI assistant. How can I help you today?");
}

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const helpText = `
I'm OpenPincer, your AI assistant.

Commands:
/start - Start a conversation
/help - Show this help message

In groups, mention me with @ to get my attention.

Just send me a message and I'll respond!
  `.trim();
  await ctx.reply(helpText);
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

  // Check if this is a group chat and we were mentioned
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const me = ctx.me;
    const mentionRegex = new RegExp(`@${me.username}`, 'i');
    if (!mentionRegex.test(text)) {
      return;
    }
  }

  const chatId = String(chat.id);
  const scope = getScope(chat.type);

  try {
    const tools = await buildTools(ctx, chatId);

    const messages: Message[] = [
      { role: 'user', content: text },
    ];

    const response = await baseAgent.chat({
      messages,
      memoryScope: scope,
      chatId,
      tools,
      maxSteps: 10,
    });

    if (!isChatText(response)) {
      await ctx.reply(FALLBACK_ERROR_MESSAGE);
      return;
    }

    await ctx.reply(response.text);

    // Store messages in memory (fire and forget)
    ingestMemory({ chatId, scope, author: 'user', text }).catch(err => {
      console.error('[Memory] Failed to store user message:', err);
    });

    ingestMemory({ chatId, scope, author: 'assistant', text: response.text }).catch(err => {
      console.error('[Memory] Failed to store assistant message:', err);
    });
  } catch (error) {
    console.error('[Telegram Handler] Error:', error);
    await ctx.reply(FALLBACK_ERROR_MESSAGE);
  }
}

export async function handleApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const match = data.match(/^(approve|deny):(.+)$/);
  if (!match) return;

  const approved = match[1] === 'approve';
  const approvalId = match[2];

  const resolved = resolveApproval(approvalId, approved);

  if (resolved) {
    await ctx.answerCallbackQuery(approved ? '✅ Approved' : '❌ Denied');
  } else {
    await ctx.answerCallbackQuery('⏱️ Request already expired');
  }

  // Remove the inline keyboard from the message
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
}

export function setupHandlers(bot: import('./bot').AppBot): void {
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.on('message:text', handleMessage);
  bot.callbackQuery(/^(approve|deny):/, handleApprovalCallback);
}
