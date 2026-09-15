import type { Context } from 'grammy';
import {
  getActiveAgent,
  clearConversation,
  clearConversationForAgent,
} from '../../db';
import { todoManager } from '../../agent';
import { compactConversation } from '../../agent/compactor';
import { getSkillsSummary, invalidateSkillsCache } from '../../tools';
import { resolveModelList } from '../../agent/model-resolver';
import { configManager } from '../../config';
import { agentRegistry } from '../../soul';
import { escapeHtml } from '../format';
import { replyChunked } from '../send';
import { chatModelPins, chatScopeOverrides, isOwner } from '../state';
import { collectStatus } from '../../commands/status';

export async function handleStartCommand(ctx: Context): Promise<void> {
  await ctx.reply("Hello! I'm OpenTalon, your AI agent. How can I help you today?");
}

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const helpText = `**OpenTalon** — your AI agent with agency.

**Bot commands**
/start — start a conversation
/help — show this message
/status — show current session status (agent, model, scope)
/new — start a fresh conversation for the active agent (preserves model pin, scope, todos) (owner only)
/reset — clear conversation history, todos, model pin, and scope override (start fresh) (owner only)
/compact [focus] — summarise the active agent's conversation history and replace it with the summary (owner only)
/cancel — stop the turn that's running: finishes the current step, then summarises what got done (owner only)
/cancel now — stop immediately and drop the in-flight step (also: send /cancel twice, or tap the button)
/listagents — list available agents and show the active one
/agent [name] — switch active agent; omit argument for interactive selection (clears conversation history)
/agent [name] [request] — route one request to that agent without switching the active agent
/listmodels — show configured primary model, fallbacks, and any active pin
/setmodel [provider/model] — pin this chat to a specific model; omit argument for interactive selection (owner only)
/resetmodel — remove model pin, restore config defaults (owner only)
/scope [private|shared|auto] — choose where this chat's memories persist; omit argument for buttons (owner only)

**Built-in capabilities**
- **Terminal** — run shell commands (_requires approval_)
- **Skill library** — save, list, run, and delete named commands
- **Specialist agents** — delegate complex tasks to a focused sub-agent (stateless: pass relevant context explicitly)

**Skill management** (just ask in plain language)
- "save a skill called ping: \`ping -c 3 1.1.1.1\`"
- "list my skills"
- "run the ping skill"
- "delete the ping skill"

**MCP tools** are loaded automatically if MCP servers are configured.

In groups, mention me with @username to get my attention.`;

  await replyChunked(ctx, helpText);
}

export async function handleStatusCommand(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const chatId = String(chat?.id);
  if (!chat || !chatId) return;

  // Collection lives in src/lib/commands/status.ts so the web channel's
  // /status reports exactly the same fields; only the rendering differs.
  const report = await collectStatus(chatId, chat.type);
  const { agent, model, session } = report;

  const lines: string[] = [];
  lines.push('<b>Status</b>');
  lines.push('');

  // Agent
  lines.push('<b>Agent</b>');
  lines.push(`  <b>ID:</b> <code>${escapeHtml(agent.id)}</code>${agent.isDefault ? ' (default)' : ''}`);
  if (agent.description) {
    lines.push(`  <b>Description:</b> ${escapeHtml(agent.description)}`);
  }
  lines.push(`  <b>RAG memory:</b> ${agent.memoryOn ? 'on' : 'off'}${!agent.memoryGlobalEnabled ? ' (disabled globally)' : !agent.ragEnabled ? ' (disabled for agent)' : ''}`);
  lines.push(`  <b>Tools:</b> ${escapeHtml(agent.toolsSummary)}`);
  lines.push('');

  // Model
  lines.push('<b>Model</b>');
  if (model.agentOverride) {
    lines.push(`  <b>Agent override:</b> <code>${escapeHtml(model.agentOverride)}</code>`);
  } else if (model.pinned) {
    lines.push(`  <b>Pinned for chat:</b> <code>${escapeHtml(model.pinned)}</code>`);
  }
  lines.push(`  <b>Primary:</b> <code>${escapeHtml(model.configuredPrimary)}</code>`);
  if (model.configuredFallbacks.length) {
    lines.push(`  <b>Fallbacks:</b> ${model.configuredFallbacks.map((fb) => `<code>${escapeHtml(fb)}</code>`).join(' → ')}`);
  }
  lines.push(`  <b>Effective now:</b> <code>${escapeHtml(model.effectivePrimary)}</code>`);
  lines.push('');

  // Session
  lines.push('<b>Session</b>');
  lines.push(`  <b>Chat:</b> <code>${escapeHtml(session.chatId)}</code> (${escapeHtml(session.chatType)})`);
  lines.push(`  <b>Scope:</b> <code>${escapeHtml(session.scope)}</code>${session.scopeOverridden ? ' (override — /scope auto to reset)' : ''}`);
  lines.push(`  <b>Context:</b> ${session.contextLine}`);
  lines.push(`  <b>Global tools:</b> ${escapeHtml(session.globalToolsSummary)}`);
  lines.push(`  <b>Scheduled tasks:</b> ${session.scheduledCount}`);
  lines.push(`  <b>Config:</b> ${session.configState === 'valid' ? 'ok' : session.configState === 'missing' ? '⚠️ missing' : `❌ invalid${session.configError ? ' — ' + escapeHtml(session.configError) : ''}`}`);

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleResetCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  if (!isOwner(ctx.message?.from?.id)) return;
  await clearConversation(chatId);
  todoManager.clear(chatId);
  chatModelPins.delete(chatId);
  chatScopeOverrides.delete(chatId);
  const activeAgentId = await getActiveAgent(chatId);
  const agentModel = agentRegistry.getSoulManager(activeAgentId).getConfig().model;
  const configured = agentModel ?? configManager.get().llm?.model ?? 'default';
  await ctx.reply(`🔄 Reset complete.\n\nUsing: ${escapeHtml(activeAgentId)} / ${escapeHtml(configured)}`);
}

/**
 * Start a fresh conversation for the active agent. Archives only the active
 * agent's history — everything else (model pin, scope override, todo list,
 * other agents' histories) is preserved. See also {@link handleResetCommand}
 * for the heavier "wipe everything for this chat" variant.
 */
export async function handleNewCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  if (!isOwner(ctx.message?.from?.id)) return;
  const activeAgentId = await getActiveAgent(chatId);
  await clearConversationForAgent(chatId, activeAgentId);
  await ctx.reply(`🆕 New conversation started for agent <code>${escapeHtml(activeAgentId)}</code>.`, {
    parse_mode: 'HTML',
  });
}

/**
 * Compact the active agent's conversation history into a single summary
 * message. Routes the summarisation call to `llm.auxModel` (falls back to
 * the chat's primary model). An optional focus string is forwarded to the
 * compactor to emphasise a specific aspect of the conversation.
 */
export async function handleCompactCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  if (!isOwner(ctx.message?.from?.id)) return;

  const focus = (ctx.match as string | undefined)?.trim() || undefined;
  const activeAgentId = await getActiveAgent(chatId);

  const pin = chatModelPins.get(chatId);
  const agentModel = agentRegistry.getSoulManager(activeAgentId).getConfig().model;
  const [primary] = resolveModelList(pin ?? agentModel, pin ? [] : undefined);

  const statusMsg = await ctx.reply('🗜️ Compacting…');

  const outcome = await compactConversation({
    chatId,
    agentId: activeAgentId,
    primary,
    focus,
  });

  if (!outcome.ok) {
    const text =
      outcome.reason === 'nothing to compact'
        ? `🗜️ Nothing to compact — no active history for agent <code>${escapeHtml(activeAgentId)}</code>.`
        : `❌ Compact failed: ${escapeHtml(outcome.reason)}`;
    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, text, { parse_mode: 'HTML' });
    return;
  }

  const reduction = outcome.beforeTokens - outcome.afterTokens;
  const pct = outcome.beforeTokens > 0 ? Math.round((reduction / outcome.beforeTokens) * 100) : 0;
  const lines = [
    '🗜️ Compacted.',
    `Before: ${outcome.beforeTokens} tokens (${outcome.messagesBefore} messages)`,
    `After:  ${outcome.afterTokens} tokens`,
    `Reduction: ${reduction} tokens (${pct}%)`,
  ];
  await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, lines.join('\n'));
}

export async function handleRefreshSkillsCommand(ctx: Context): Promise<void> {
  invalidateSkillsCache();
  const summary = await getSkillsSummary();
  const count = summary ? summary.split('\n').length : 0;
  await ctx.reply(`🔄 Skills refreshed! Found ${count} skill(s).\n\n${summary || 'No skills found.'}`);
}
