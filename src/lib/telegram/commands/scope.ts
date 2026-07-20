import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { MemoryScope } from '../../memory';
import { escapeHtml } from '../format';
import { chatScopeOverrides, getDefaultScope, getScope, isOwner } from '../state';

/**
 * /scope — control where this chat's recalled memories persist (private ⇄
 * shared), overriding the chat-type default (private in DMs, shared in groups).
 * The override lives in memory and resets on /scope auto, /reset, or restart.
 */

/** Human-readable summary of the current scope state for a chat. */
function scopeStatus(chatType: string, chatId: string): string {
  const def = getDefaultScope(chatType);
  const override = chatScopeOverrides.get(chatId);
  const effective = getScope(chatType, chatId);

  const lines: string[] = [];
  lines.push(`<b>Memory scope:</b> <code>${effective}</code>`);
  if (override) {
    lines.push(`Override active — default for this chat is <code>${def}</code>.`);
    lines.push('<i>Use /scope auto to restore the default.</i>');
  } else {
    lines.push(`Following the chat-type default (<code>${def}</code>).`);
  }
  lines.push('');
  lines.push(
    "<i>'private' keeps recalled memories to this 1-1 conversation; " +
    "'shared' pools them with group memories.</i>",
  );
  return lines.join('\n');
}

function scopeKeyboard(chatType: string, chatId: string): InlineKeyboard {
  const def = getDefaultScope(chatType);
  const effective = getScope(chatType, chatId);
  const overridden = chatScopeOverrides.has(chatId);
  const mark = (s: MemoryScope) => (!overridden ? '' : effective === s ? ' ✓' : '');
  return new InlineKeyboard()
    .text(`Private${mark('private')}`, 'scope:set:private')
    .text(`Shared${mark('shared')}`, 'scope:set:shared')
    .row()
    .text(`Auto — default (${def})${!overridden ? ' ✓' : ''}`, 'scope:set:auto')
    .row()
    .text('✖ Cancel', 'scope:cancel');
}

function applyScope(chatId: string, choice: string): { ok: boolean; label: string } {
  if (choice === 'private' || choice === 'shared') {
    chatScopeOverrides.set(chatId, choice);
    return { ok: true, label: choice };
  }
  if (choice === 'auto' || choice === 'reset' || choice === 'default') {
    chatScopeOverrides.delete(chatId);
    return { ok: true, label: 'auto' };
  }
  return { ok: false, label: choice };
}

/** Confirmation text after a scope change. */
function confirmation(chatType: string, chatId: string, label: string): string {
  if (label === 'auto') {
    return (
      `Memory scope override cleared — following the chat-type default ` +
      `(<code>${getDefaultScope(chatType)}</code>).`
    );
  }
  return (
    `Memory scope set to <code>${escapeHtml(label)}</code> for this chat.\n` +
    `New memories persist as <code>${escapeHtml(label)}</code> until you run /scope auto or restart.`
  );
}

export async function handleScopeCommand(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const chatId = String(chat?.id);
  if (!chat || !chatId || !isOwner(ctx.message?.from?.id)) return;

  const arg = (ctx.match as string | undefined)?.trim().toLowerCase();

  // No argument — show current state with interactive buttons.
  if (!arg) {
    await ctx.reply(scopeStatus(chat.type, chatId), {
      parse_mode: 'HTML',
      reply_markup: scopeKeyboard(chat.type, chatId),
    });
    return;
  }

  const { ok, label } = applyScope(chatId, arg);
  if (!ok) {
    await ctx.reply(
      'Usage: <code>/scope private</code>, <code>/scope shared</code>, or <code>/scope auto</code> ' +
      '(default for the chat type). Omit the argument for buttons.',
      { parse_mode: 'HTML' },
    );
    return;
  }
  await ctx.reply(confirmation(chat.type, chatId, label), { parse_mode: 'HTML' });
}

export async function handleScopeCallback(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const chatId = String(chat?.id);
  if (!chat || !chatId || !isOwner(ctx.callbackQuery?.from?.id)) {
    await ctx.answerCallbackQuery('Not authorized.');
    return;
  }

  const data = ctx.callbackQuery?.data ?? '';

  if (data === 'scope:cancel') {
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }));
    return;
  }

  const pick = data.match(/^scope:set:(private|shared|auto)$/);
  if (pick) {
    const { label } = applyScope(chatId, pick[1]);
    await ctx.answerCallbackQuery(label === 'auto' ? 'Following chat default.' : `Scope: ${label}`);
    await ctx.editMessageText(confirmation(chat.type, chatId, label), { parse_mode: 'HTML' });
  }
}
