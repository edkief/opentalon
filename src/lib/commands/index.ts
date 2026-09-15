/**
 * Channel-agnostic slash commands.
 *
 * Telegram gets its commands from grammY's own `bot.command(...)` router
 * (`src/lib/telegram/handlers.ts`), which never sees a message arriving on any
 * other channel. This module is the equivalent router for channels that
 * receive plain text over HTTP — today the dashboard's web chat
 * (`src/app/api/chat/route.ts`), which until now handed `/reset` straight to
 * the model as a user message.
 *
 * Output is **plain text**: the dashboard transcript renders message content
 * with `whitespace-pre-wrap` and no markup parser, so Telegram's HTML spans
 * would show up as literal `<b>` tags. Commands whose Telegram counterpart is
 * an inline keyboard (`/agent` with no argument, `/setmodel` with no argument,
 * `/scope` with no argument) degrade to listing the choices and the argument
 * that picks one.
 */
import {
  clearConversation,
  clearConversationForAgent,
  getActiveAgent,
  setActiveAgent,
} from '../db';
import { todoManager } from '../agent';
import { compactConversation } from '../agent/compactor';
import { turnCancellation, type TurnCancelMode } from '../agent/cancellation';
import { parseModelString, getApiKeyForProvider, resolveModelList } from '../agent/model-resolver';
import { configManager } from '../config';
import { agentRegistry } from '../soul';
import { getSkillsSummary, invalidateSkillsCache } from '../tools';
import { chatModelPins, chatScopeOverrides, getDefaultScope, getScope } from '../telegram/state';
import { collectStatus, type StatusReport } from './status';
import type { ChatCommand, ChatCommandName } from './parse';

export * from './parse';

export interface ChatCommandContext {
  chatId: string;
  threadId: string;
  /** The agent the caller is currently talking to. */
  agentId: string;
  /** Drives the default memory scope; web chats are 1-1, hence 'private'. */
  chatType: string;
}

export interface ChatCommandResult {
  /** Reply to show the user. Absent when the command delegates to a turn. */
  text?: string;
  /**
   * Set when the command asks for a normal agent turn instead of a reply —
   * `/agent <name> <request>` routes one request to another agent without
   * switching the chat. The caller runs its usual LLM path with these.
   */
  route?: { agentId: string; message: string };
  /** Set when the command changed the chat's active agent, so UIs can follow. */
  activeAgentId?: string;
}

/** Words that mean "don't wait for the current step" on `/cancel <arg>`. */
const FORCE_WORDS = new Set(['now', 'force', 'hard', '!', 'kill']);

const KNOWN_PROVIDERS = ['anthropic', 'openai', 'mistral', 'minimax', 'google'];

export async function runChatCommand(
  command: ChatCommand,
  ctx: ChatCommandContext,
): Promise<ChatCommandResult> {
  return HANDLERS[command.name](command.args, ctx);
}

// ── Handlers ────────────────────────────────────────────────────────────────

type Handler = (args: string, ctx: ChatCommandContext) => Promise<ChatCommandResult>;

const HELP_TEXT = `OpenTalon — chat commands

/help — show this message
/status — current agent, model, scope, context size
/new — start a fresh conversation for the active agent (keeps model pin, scope, todos)
/reset — clear history, todos, model pin, and scope override
/compact [focus] — summarise this agent's history and replace it with the summary
/cancel [now] — stop the running turn; "now" drops the in-flight step
/refresh_skills — re-read the skills directory
/listagents — list agents and show the active one
/agent <name> — switch the active agent for this chat
/agent <name> <request> — route one request to another agent without switching
/listmodels — configured primary, fallbacks, and any pin
/setmodel <provider/model> — pin this chat to a model
/resetmodel — remove the pin
/scope <private|shared|auto> — where this chat's memories persist

Anything else is sent to the agent as a message.`;

const handleHelp: Handler = async () => ({ text: HELP_TEXT });

function renderStatus(r: StatusReport): string {
  const lines: string[] = [];
  lines.push('Status');
  lines.push('');
  lines.push('Agent');
  lines.push(`  ID: ${r.agent.id}${r.agent.isDefault ? ' (default)' : ''}`);
  if (r.agent.description) lines.push(`  Description: ${r.agent.description}`);
  lines.push(
    `  RAG memory: ${r.agent.memoryOn ? 'on' : 'off'}` +
      (!r.agent.memoryGlobalEnabled
        ? ' (disabled globally)'
        : !r.agent.ragEnabled
          ? ' (disabled for agent)'
          : ''),
  );
  lines.push(`  Tools: ${r.agent.toolsSummary}`);
  lines.push('');
  lines.push('Model');
  if (r.model.agentOverride) lines.push(`  Agent override: ${r.model.agentOverride}`);
  else if (r.model.pinned) lines.push(`  Pinned for chat: ${r.model.pinned}`);
  lines.push(`  Primary: ${r.model.configuredPrimary}`);
  if (r.model.configuredFallbacks.length) {
    lines.push(`  Fallbacks: ${r.model.configuredFallbacks.join(' → ')}`);
  }
  lines.push(`  Effective now: ${r.model.effectivePrimary}`);
  lines.push('');
  lines.push('Session');
  lines.push(`  Chat: ${r.session.chatId} (${r.session.chatType})`);
  lines.push(
    `  Scope: ${r.session.scope}${r.session.scopeOverridden ? ' (override — /scope auto to reset)' : ''}`,
  );
  lines.push(`  Context: ${r.session.contextLine}`);
  lines.push(`  Global tools: ${r.session.globalToolsSummary}`);
  lines.push(`  Scheduled tasks: ${r.session.scheduledCount}`);
  lines.push(
    `  Config: ${
      r.session.configState === 'valid'
        ? 'ok'
        : r.session.configState === 'missing'
          ? '⚠️ missing'
          : `❌ invalid${r.session.configError ? ' — ' + r.session.configError : ''}`
    }`,
  );
  return lines.join('\n');
}

const handleStatus: Handler = async (_args, ctx) => ({
  text: renderStatus(await collectStatus(ctx.chatId, ctx.chatType)),
});

const handleReset: Handler = async (_args, ctx) => {
  await clearConversation(ctx.chatId);
  todoManager.clear(ctx.chatId);
  chatModelPins.delete(ctx.chatId);
  chatScopeOverrides.delete(ctx.chatId);
  const activeAgentId = await getActiveAgent(ctx.chatId);
  const agentModel = agentRegistry.getSoulManager(activeAgentId).getConfig().model;
  const configured = agentModel ?? configManager.get().llm?.model ?? 'default';
  return { text: `🔄 Reset complete.\n\nUsing: ${activeAgentId} / ${configured}` };
};

const handleNew: Handler = async (_args, ctx) => {
  const activeAgentId = await getActiveAgent(ctx.chatId);
  await clearConversationForAgent(ctx.chatId, activeAgentId);
  return { text: `🆕 New conversation started for agent ${activeAgentId}.` };
};

const handleCompact: Handler = async (args, ctx) => {
  const focus = args || undefined;
  const activeAgentId = await getActiveAgent(ctx.chatId);
  const pin = chatModelPins.get(ctx.chatId);
  const agentModel = agentRegistry.getSoulManager(activeAgentId).getConfig().model;
  const [primary] = resolveModelList(pin ?? agentModel, pin ? [] : undefined);

  const outcome = await compactConversation({ chatId: ctx.chatId, agentId: activeAgentId, primary, focus });

  if (!outcome.ok) {
    return {
      text:
        outcome.reason === 'nothing to compact'
          ? `🗜️ Nothing to compact — no active history for agent ${activeAgentId}.`
          : `❌ Compact failed: ${outcome.reason}`,
    };
  }

  const reduction = outcome.beforeTokens - outcome.afterTokens;
  const pct = outcome.beforeTokens > 0 ? Math.round((reduction / outcome.beforeTokens) * 100) : 0;
  return {
    text: [
      '🗜️ Compacted.',
      `Before: ${outcome.beforeTokens} tokens (${outcome.messagesBefore} messages)`,
      `After:  ${outcome.afterTokens} tokens`,
      `Reduction: ${reduction} tokens (${pct}%)`,
    ].join('\n'),
  };
};

const handleCancel: Handler = async (args, ctx) => {
  const mode: TurnCancelMode = FORCE_WORDS.has(args.toLowerCase()) ? 'force' : 'graceful';
  const outcome = turnCancellation.request(ctx.chatId, mode);

  if (outcome.status === 'none') return { text: '💤 Nothing running to cancel.' };
  if (outcome.status === 'force') {
    return { text: outcome.escalated ? '⏹ Escalating — stopping immediately.' : '⏹ Stopping immediately.' };
  }
  return {
    text:
      '⏹ Stopping after the current step — I’ll summarise what got done.\n' +
      'Send /cancel now to drop it immediately instead.',
  };
};

const handleRefreshSkills: Handler = async () => {
  invalidateSkillsCache();
  const summary = await getSkillsSummary();
  const count = summary ? summary.split('\n').length : 0;
  return { text: `🔄 Skills refreshed! Found ${count} skill(s).\n\n${summary || 'No skills found.'}` };
};

const handleListAgents: Handler = async (_args, ctx) => {
  const agents = agentRegistry.listAgents();
  const active = await getActiveAgent(ctx.chatId);
  if (agents.length === 0) return { text: 'No agents found.' };
  const lines = agents.map((p) => `• ${p.id}${p.id === active ? ' ✓' : ''}`);
  return { text: `Available agents:\n${lines.join('\n')}\n\nActive: ${active}` };
};

const handleAgent: Handler = async (args, ctx) => {
  // Split "<agentId> <request…>": first token picks the agent, the rest (if
  // any) is a one-off request routed to that agent without switching the chat.
  const spaceIdx = args.search(/\s/);
  const agentId = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
  const request = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();

  if (!agentId) {
    const agents = agentRegistry.listAgents();
    if (agents.length === 0) return { text: 'No agents available.' };
    const active = await getActiveAgent(ctx.chatId);
    const lines = agents.map((p) => `• ${p.id}${p.id === active ? ' ✓' : ''}`);
    return { text: `Usage: /agent <name>\n\n${lines.join('\n')}` };
  }

  if (!agentRegistry.agentExists(agentId)) {
    const available = agentRegistry.listAgents().map((p) => p.id).join(', ');
    return { text: `Agent "${agentId}" not found.\n\nAvailable: ${available || 'none'}` };
  }

  // One-off route: run this single request as the chosen agent, leaving the
  // chat's active agent unchanged.
  if (request) return { route: { agentId, message: request } };

  await setActiveAgent(ctx.chatId, ctx.threadId, agentId);
  return {
    activeAgentId: agentId,
    text:
      `Switched to agent: ${agentId}.\n\n` +
      `This agent's existing history for this chat is kept — run /new to clear it, ` +
      `or /reset to fully reset the chat (all agents + model pins).`,
  };
};

const handleListModels: Handler = async (_args, ctx) => {
  const cfg = configManager.get().llm ?? {};
  const primary = cfg.model ?? process.env.LLM_MODEL ?? '(auto-detect)';
  const fallbacks = cfg.fallbacks ?? [];
  const pinned = chatModelPins.get(ctx.chatId);

  const lines: string[] = [`Primary: ${primary}${pinned ? '' : ' ✓'}`];
  if (fallbacks.length) {
    lines.push('', 'Fallbacks:');
    for (const fb of fallbacks) lines.push(`  • ${fb}`);
  }
  if (pinned) {
    lines.push('', `Pinned (this chat): ${pinned} ✓`, 'Use /resetmodel to restore default behaviour.');
  }
  return { text: lines.join('\n') };
};

/** Configured models whose provider is known and has an API key. */
function availableModels(): string[] {
  const cfg = configManager.get().llm ?? {};
  const configured = [cfg.model, ...(cfg.fallbacks ?? [])].filter((s): s is string => Boolean(s));
  const customProviders = configManager.getSecrets().providers?.map((p) => p.name) ?? [];
  const allKnown = new Set([...KNOWN_PROVIDERS, ...customProviders]);
  return configured.filter((s) => {
    const parsed = parseModelString(s);
    return Boolean(parsed && allKnown.has(parsed.provider) && getApiKeyForProvider(parsed.provider));
  });
}

const handleSetModel: Handler = async (args, ctx) => {
  if (!args) {
    const models = availableModels();
    if (models.length === 0) {
      return { text: 'No configured providers with API keys found. Add API keys to secrets.yaml.' };
    }
    return { text: `Usage: /setmodel <provider/model>\n\n${models.map((m) => `• ${m}`).join('\n')}` };
  }

  const parsed = parseModelString(args);
  if (!parsed) {
    return { text: 'Invalid format. Use provider/model, e.g. anthropic/claude-sonnet-4-5.' };
  }

  const customProviders = configManager.getSecrets().providers?.map((p) => p.name) ?? [];
  const allKnown = new Set([...KNOWN_PROVIDERS, ...customProviders]);
  if (!allKnown.has(parsed.provider) || !getApiKeyForProvider(parsed.provider)) {
    const available = [...allKnown].filter((p) => getApiKeyForProvider(p));
    return {
      text:
        `Provider ${parsed.provider} is not configured or has no API key.\n\n` +
        `Configured providers: ${available.join(', ') || 'none'}`,
    };
  }

  chatModelPins.set(ctx.chatId, args);
  return {
    text:
      `Model pinned to ${args} for this chat.\n` +
      'Fallbacks are disabled while pinned.\nUse /resetmodel to restore defaults.',
  };
};

const handleResetModel: Handler = async (_args, ctx) => {
  const wasPinned = chatModelPins.get(ctx.chatId);
  chatModelPins.delete(ctx.chatId);
  const primary = configManager.get().llm?.model ?? process.env.LLM_MODEL ?? '(auto-detect)';
  return {
    text: wasPinned
      ? `Model pin removed. Back to configured primary: ${primary}`
      : `No model was pinned. Using configured primary: ${primary}`,
  };
};

const handleScope: Handler = async (args, ctx) => {
  const def = getDefaultScope(ctx.chatType);
  const arg = args.toLowerCase();

  if (!arg) {
    const effective = getScope(ctx.chatType, ctx.chatId);
    const overridden = chatScopeOverrides.has(ctx.chatId);
    const lines = [`Memory scope: ${effective}`];
    lines.push(
      overridden
        ? `Override active — default for this chat is ${def}. Use /scope auto to restore it.`
        : `Following the chat-type default (${def}).`,
    );
    lines.push('', 'Usage: /scope private | shared | auto');
    lines.push(
      "'private' keeps recalled memories to this 1-1 conversation; 'shared' pools them with group memories.",
    );
    return { text: lines.join('\n') };
  }

  if (arg === 'private' || arg === 'shared') {
    chatScopeOverrides.set(ctx.chatId, arg);
    return {
      text:
        `Memory scope set to ${arg} for this chat.\n` +
        `New memories persist as ${arg} until you run /scope auto or restart.`,
    };
  }

  if (arg === 'auto' || arg === 'reset' || arg === 'default') {
    chatScopeOverrides.delete(ctx.chatId);
    return { text: `Memory scope override cleared — following the chat-type default (${def}).` };
  }

  return { text: 'Usage: /scope private, /scope shared, or /scope auto (default for the chat type).' };
};

const HANDLERS: Record<ChatCommandName, Handler> = {
  help: handleHelp,
  start: handleHelp,
  status: handleStatus,
  reset: handleReset,
  new: handleNew,
  compact: handleCompact,
  cancel: handleCancel,
  refresh_skills: handleRefreshSkills,
  listagents: handleListAgents,
  agent: handleAgent,
  listmodels: handleListModels,
  setmodel: handleSetModel,
  resetmodel: handleResetModel,
  scope: handleScope,
};
