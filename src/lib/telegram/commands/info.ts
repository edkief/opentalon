import type { Context } from 'grammy';
import { getActiveAgent, clearConversation } from '../../db';
import { todoManager } from '../../agent';
import { getSkillsSummary, invalidateSkillsCache } from '../../tools';
import { resolveModelList } from '../../agent/model-resolver';
import { configManager } from '../../config';
import { schedulerService } from '../../scheduler';
import { agentRegistry } from '../../soul';
import { escapeHtml } from '../format';
import { replyChunked } from '../send';
import { chatModelPins, getScope, getToolAllowlist } from '../state';

export async function handleStartCommand(ctx: Context): Promise<void> {
  await ctx.reply("Hello! I'm OpenTalon, your AI assistant. How can I help you today?");
}

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const helpText = `**OpenTalon** — your AI assistant with agency.

**Bot commands**
/start — start a conversation
/help — show this message
/status — show current session status (agent, model, scope)
/reset — reset conversation, agent, and model (start fresh)
/listagents — list available agents and show the active one
/agent [name] — switch active agent; omit argument for interactive selection (clears conversation history)
/listmodels — show configured primary model, fallbacks, and any active pin
/setmodel [provider/model] — pin this chat to a specific model; omit argument for interactive selection (owner only)
/resetmodel — remove model pin, restore config defaults (owner only)

**Built-in capabilities**
- **Terminal** — run shell commands (_requires approval_)
- **Skill library** — save, list, run, and delete named commands
- **Specialist agents** — delegate complex tasks to a focused sub-agent

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

  const scope = getScope(chat.type);
  const activeAgentId = await getActiveAgent(chatId);

  // ── Agent info ────────────────────────────────────────────────────────────
  const agentSm = agentRegistry.getSoulManager(activeAgentId);
  const agentConfig = agentSm.getConfig();
  const agentDescription = agentConfig.description;

  // ── Model resolution ──────────────────────────────────────────────────────
  const cfg = configManager.get().llm ?? {};
  const configuredPrimary = cfg.model ?? process.env.LLM_MODEL ?? '(auto-detect)';
  const configuredFallbacks = cfg.fallbacks ?? [];
  const pinned = chatModelPins.get(chatId);

  // Agent-level model overrides global config
  const agentModelOverride = agentConfig.model;

  let effectiveModels: string[] = [];
  try {
    effectiveModels = resolveModelList(agentModelOverride ?? pinned).map((m) => m.modelString);
  } catch {
    // ignore – fall back to configured values below
  }

  const effectivePrimary = effectiveModels[0] ?? agentModelOverride ?? pinned ?? configuredPrimary;

  // ── Memory / RAG ──────────────────────────────────────────────────────────
  const memoryGlobalEnabled = configManager.get().memory?.enabled !== false;
  const ragEnabled = agentConfig.ragEnabled !== false; // default true
  const memoryOn = memoryGlobalEnabled && ragEnabled;

  // ── Tools ─────────────────────────────────────────────────────────────────
  const toolAllowlist = getToolAllowlist();
  const toolsSummary = toolAllowlist === '*' ? 'all' : `${toolAllowlist.size} allowed`;

  const agentTools = agentConfig.tools;
  const agentToolsSummary = !agentTools || agentTools.length === 0
    ? 'inherits global'
    : `${agentTools.length} allowed`;

  // ── Scheduled tasks ───────────────────────────────────────────────────────
  let scheduledCount = 0;
  try {
    const schedules = await schedulerService.getSchedules(chatId);
    scheduledCount = schedules.length;
  } catch {
    // scheduler may not be initialised yet
  }

  // ── Config health ─────────────────────────────────────────────────────────
  const configState = configManager.state;

  // ── Build message ─────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('<b>Status</b>');
  lines.push('');

  // Agent
  lines.push('<b>Agent</b>');
  lines.push(`  <b>ID:</b> <code>${escapeHtml(activeAgentId)}</code>${agentRegistry.isDefaultAgent(activeAgentId) ? ' (default)' : ''}`);
  if (agentDescription) {
    lines.push(`  <b>Description:</b> ${escapeHtml(agentDescription)}`);
  }
  lines.push(`  <b>RAG memory:</b> ${memoryOn ? 'on' : 'off'}${!memoryGlobalEnabled ? ' (disabled globally)' : !ragEnabled ? ' (disabled for agent)' : ''}`);
  lines.push(`  <b>Tools:</b> ${escapeHtml(agentToolsSummary)}`);
  lines.push('');

  // Model
  lines.push('<b>Model</b>');
  if (agentModelOverride) {
    lines.push(`  <b>Agent override:</b> <code>${escapeHtml(agentModelOverride)}</code>`);
  } else if (pinned) {
    lines.push(`  <b>Pinned for chat:</b> <code>${escapeHtml(pinned)}</code>`);
  }
  lines.push(`  <b>Primary:</b> <code>${escapeHtml(configuredPrimary)}</code>`);
  if (configuredFallbacks.length) {
    lines.push(`  <b>Fallbacks:</b> ${configuredFallbacks.map((fb) => `<code>${escapeHtml(fb)}</code>`).join(' → ')}`);
  }
  lines.push(`  <b>Effective now:</b> <code>${escapeHtml(effectivePrimary)}</code>`);
  lines.push('');

  // Session
  lines.push('<b>Session</b>');
  lines.push(`  <b>Chat:</b> <code>${escapeHtml(chatId)}</code> (${escapeHtml(chat.type)})`);
  lines.push(`  <b>Scope:</b> <code>${escapeHtml(scope)}</code>`);
  lines.push(`  <b>Global tools:</b> ${escapeHtml(toolsSummary)}`);
  lines.push(`  <b>Scheduled tasks:</b> ${scheduledCount}`);
  lines.push(`  <b>Config:</b> ${configState === 'valid' ? 'ok' : configState === 'missing' ? '⚠️ missing' : `❌ invalid${configManager.error ? ' — ' + escapeHtml(configManager.error) : ''}`}`);

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleResetCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  await clearConversation(chatId);
  todoManager.clear(chatId);
  chatModelPins.delete(chatId);
  const activeAgentId = await getActiveAgent(chatId);
  const agentModel = agentRegistry.getSoulManager(activeAgentId).getConfig().model;
  const configured = agentModel ?? configManager.get().llm?.model ?? 'default';
  await ctx.reply(`🔄 Reset complete.\n\nUsing: ${escapeHtml(activeAgentId)} / ${escapeHtml(configured)}`);
}

export async function handleRefreshSkillsCommand(ctx: Context): Promise<void> {
  invalidateSkillsCache();
  const summary = await getSkillsSummary();
  const count = summary ? summary.split('\n').length : 0;
  await ctx.reply(`🔄 Skills refreshed! Found ${count} skill(s).\n\n${summary || 'No skills found.'}`);
}
