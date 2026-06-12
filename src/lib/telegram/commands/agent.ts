import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { getActiveAgent, setActiveAgent, clearConversationForAgent } from '../../db';
import { todoManager } from '../../agent';
import { agentRegistry } from '../../soul';
import { escapeHtml } from '../format';
import { isOwner } from '../state';

export async function handleListAgentsCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;

  const agents = agentRegistry.listAgents();
  const active = await getActiveAgent(chatId);

  const lines = agents.map((p) => {
    const marker = p.id === active ? ' ✓' : '';
    return `• <b>${escapeHtml(p.id)}</b>${marker}`;
  });

  const text = agents.length === 0
    ? 'No agents found.'
    : `<b>Available agents:</b>\n${lines.join('\n')}\n\nActive: <b>${escapeHtml(active)}</b>`;

  await ctx.reply(text, { parse_mode: 'HTML' });
}

export async function handleAgentCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.message?.from?.id)) return;

  const agentId = (ctx.match as string | undefined)?.trim();

  // No argument — show inline keyboard
  if (!agentId) {
    const agents = agentRegistry.listAgents();
    if (agents.length === 0) {
      await ctx.reply('No agents available.', { parse_mode: 'HTML' });
      return;
    }
    const active = await getActiveAgent(chatId);
    const kb = new InlineKeyboard();
    agents.forEach((p, i) => {
      const label = p.id === active ? `${p.id} ✓` : p.id;
      kb.text(label, `agent:pick:${p.id}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text('✖ Cancel', 'agent:cancel');
    await ctx.reply('Select a agent:', { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  if (!agentRegistry.agentExists(agentId)) {
    const available = agentRegistry.listAgents().map((p) => p.id).join(', ');
    await ctx.reply(
      `Agent "<b>${escapeHtml(agentId)}</b>" not found.\n\nAvailable: ${escapeHtml(available || 'none')}`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  await setActiveAgent(chatId, agentId);
  const keyboard = new InlineKeyboard()
    .text('🧹 Clear history', `agent:clear:${agentId}`)
    .text('➡️ Skip', `agent:keep:${agentId}`);

  await ctx.reply(
    `Switched to agent: <b>${escapeHtml(agentId)}</b>.\n\nDo you want to clear this agent's history for this chat?\n\nYou can always run <code>/reset</code> later to fully reset the chat (all agents + model pins).`,
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
}

export async function handleAgentCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.callbackQuery?.from?.id)) {
    await ctx.answerCallbackQuery('Not authorized.');
    return;
  }

  const data = ctx.callbackQuery?.data ?? '';

  if (data === 'agent:cancel') {
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }));
    return;
  }

  const clearMatch = data.match(/^agent:clear:(.+)$/);
  if (clearMatch) {
    const agentId = clearMatch[1];
    if (!agentRegistry.agentExists(agentId)) {
      await ctx.answerCallbackQuery('Agent no longer exists.');
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }
    await clearConversationForAgent(chatId, agentId);
    todoManager.clear(chatId);
    await ctx.answerCallbackQuery('History cleared.');
    await ctx.editMessageText(
      `Switched to agent: <b>${escapeHtml(agentId)}</b>.\n\nConversation history for this agent in this chat has been cleared.\n\nUse <code>/reset</code> to fully reset the chat (all agents + model pins).`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const keepMatch = data.match(/^agent:keep:(.+)$/);
  if (keepMatch) {
    const agentId = keepMatch[1];
    if (!agentRegistry.agentExists(agentId)) {
      await ctx.answerCallbackQuery('Agent no longer exists.');
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }
    await ctx.answerCallbackQuery('Keeping history.');
    await ctx.editMessageText(
      `Switched to agent: <b>${escapeHtml(agentId)}</b>.\n\nExisting history for this agent in this chat has been kept.\n\nYou can run <code>/reset</code> at any time to fully reset the chat (all agents + model pins).`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const pickMatch = data.match(/^agent:pick:(.+)$/);
  if (pickMatch) {
    const agentId = pickMatch[1];
    if (!agentRegistry.agentExists(agentId)) {
      await ctx.answerCallbackQuery('Agent no longer exists.');
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      return;
    }
    await setActiveAgent(chatId, agentId);
    const keyboard = new InlineKeyboard()
      .text('🧹 Clear history', `agent:clear:${agentId}`)
      .text('➡️ Skip', `agent:keep:${agentId}`);

    await ctx.answerCallbackQuery(`Switched to ${agentId}`);
    await ctx.editMessageText(
      `Switched to agent: <b>${escapeHtml(agentId)}</b>.\n\nDo you want to clear this agent's history for this chat?\n\nYou can always run <code>/reset</code> later to fully reset the chat (all agents + model pins).`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  }
}
