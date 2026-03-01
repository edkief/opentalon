import type { Context } from 'grammy';
import { baseAgent } from '../agent';
import { ingestMemory } from '../memory';
import type { Message } from '../agent/types';
import type { MemoryScope } from '../memory';

const FALLBACK_ERROR_MESSAGE = "My brain is a bit foggy right now, give me a second...";

function getScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
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
      // Not mentioned, ignore
      return;
    }
  }

  const chatId = String(chat.id);
  const scope = getScope(chat.type);

  try {
    const messages: Message[] = [
      { role: 'user', content: text },
    ];

    const response = await baseAgent.chat({
      messages,
      memoryScope: scope,
      chatId,
    });

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

export function setupHandlers(bot: import('./bot').AppBot): void {
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.on('message:text', handleMessage);
}
