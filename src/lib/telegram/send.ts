import type { Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { InlineKeyboard } from 'grammy';
import { getTelegramChunks } from 'md-to-tg';
import type { AppBot } from './bot';
import { splitMessage } from './format';

// Bot reference for callbacks that run outside a Telegraf context (e.g. job completions).
let _bot: AppBot | null = null;

/** Register the bot instance so callbacks outside a Grammy ctx can send messages. */
export function setBot(bot: AppBot): void {
  _bot = bot;
}

/** The bot instance, or null before setupHandlers has run. */
export function getBot(): AppBot | null {
  return _bot;
}

/** Send text to Telegram, splitting into multiple messages if needed. */
export async function replyChunked(ctx: Context, text: string): Promise<void> {
  const chunks = getTelegramChunks(text);
  for (const { text: plainText, entities } of chunks) {
    try {
      await ctx.reply(plainText, { entities: entities as MessageEntity[] });
    } catch (e) {
      console.warn('[WARN] Failed to send with entities, falling back to plain text:', e);
      await ctx.reply(plainText);
    }
  }
}

/** Send text to a chat by ID (used for job callbacks outside a Telegraf context). */
export async function sendToChat(
  chatId: string,
  text: string,
  formatOrOptions?: 'markdown' | 'html' | { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard },
  throwOnError = false,
): Promise<void> {
  if (!_bot) return;
  // Non-Telegram channels (e.g. web, chatId="web") have no bot API to send to.
  // Return silently so callers that run after sendToChat (e.g. addMessage) still execute.
  if (!/^-?\d+$/.test(chatId)) return;

  let parseMode: 'HTML' | undefined;
  let replyMarkup: InlineKeyboard | undefined;

  if (formatOrOptions && typeof formatOrOptions === 'object') {
    parseMode = formatOrOptions.parse_mode;
    replyMarkup = formatOrOptions.reply_markup;
  } else if (formatOrOptions === 'html') {
    parseMode = 'HTML';
  }

  // HTML mode: text is pre-formatted HTML, split on raw length and send with parse_mode.
  if (parseMode || formatOrOptions === 'html') {
    for (const chunk of splitMessage(text)) {
      try {
        try {
          await _bot.api.sendMessage(chatId, chunk, { parse_mode: parseMode, reply_markup: replyMarkup });
        } catch {
          await _bot.api.sendMessage(chatId, chunk, { reply_markup: replyMarkup });
        }
      } catch (err) {
        if (throwOnError) throw err;
        console.error('[sendToChat] Failed to deliver message to chat', chatId, err);
      }
    }
    return;
  }

  // Default: convert markdown to plain text + entities. getTelegramChunks handles splitting,
  // guaranteeing each chunk fits within Telegram's 4096-char limit even when table formatting
  // expands the output beyond the raw markdown length.
  for (const { text: plainText, entities } of getTelegramChunks(text)) {
    try {
      try {
        await _bot.api.sendMessage(chatId, plainText, { entities: entities as MessageEntity[], reply_markup: replyMarkup });
      } catch {
        // Entity send failed; fall back to plain text rather than raw markdown.
        await _bot.api.sendMessage(chatId, plainText, { reply_markup: replyMarkup });
      }
    } catch (err) {
      if (throwOnError) throw err;
      console.error('[sendToChat] Failed to deliver message to chat', chatId, err);
    }
  }
}
