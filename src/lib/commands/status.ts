import {
  getActiveAgent,
  getConversationHistory,
  getLastTurnContextSize,
} from '../db';
import { estimateTokens } from '../agent/context-attribution';
import { resolveModelList } from '../agent/model-resolver';
import { configManager } from '../config';
import { schedulerService } from '../scheduler';
import { agentRegistry } from '../soul';
import { chatModelPins, chatScopeOverrides, getScope, getToolAllowlist } from '../telegram/state';

/**
 * Everything `/status` reports, gathered once and rendered per channel.
 *
 * Telegram renders this as HTML with inline `<code>` spans; the web dashboard
 * renders the same fields as plain text (its transcript is `whitespace-pre-wrap`
 * and does not parse markup). Keeping the collection here means the two can't
 * drift into reporting different things.
 */
export interface StatusReport {
  agent: {
    id: string;
    isDefault: boolean;
    description?: string;
    memoryOn: boolean;
    memoryGlobalEnabled: boolean;
    ragEnabled: boolean;
    toolsSummary: string;
  };
  model: {
    agentOverride?: string;
    pinned?: string;
    configuredPrimary: string;
    configuredFallbacks: string[];
    effectivePrimary: string;
  };
  session: {
    chatId: string;
    chatType: string;
    scope: string;
    scopeOverridden: boolean;
    contextLine: string;
    globalToolsSummary: string;
    scheduledCount: number;
    configState: string;
    configError: string | null;
  };
}

export async function collectStatus(chatId: string, chatType: string): Promise<StatusReport> {
  const scope = getScope(chatType, chatId);
  const scopeOverridden = chatScopeOverrides.has(chatId);
  const activeAgentId = await getActiveAgent(chatId);

  // ── Agent info ────────────────────────────────────────────────────────────
  const agentConfig = agentRegistry.getSoulManager(activeAgentId).getConfig();

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

  // ── Tools ─────────────────────────────────────────────────────────────────
  const toolAllowlist = getToolAllowlist();
  const globalToolsSummary = toolAllowlist === '*' ? 'all' : `${toolAllowlist.size} allowed`;

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

  // ── Context size ──────────────────────────────────────────────────────────
  // Prefer the provider-reported exact total from the last completed turn —
  // same source `/compact` uses for `beforeTokens` (see compactor.ts:139). If
  // no turn has been recorded yet, fall back to the local heuristic over the
  // current history rows (same `estimateTokens` the context-attribution
  // report uses), prefixed with `~` to mark it as estimated.
  let contextLine: string;
  try {
    const { tokens, messageCount } = await getLastTurnContextSize(chatId, activeAgentId);
    if (tokens !== null) {
      contextLine = `${tokens} tokens (${messageCount} messages)`;
    } else {
      const history = await getConversationHistory(chatId, activeAgentId, 20);
      const estimated = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      contextLine = `~${estimated} tokens (${history.length} messages, est.)`;
    }
  } catch {
    contextLine = '— (unavailable)';
  }

  return {
    agent: {
      id: activeAgentId,
      isDefault: agentRegistry.isDefaultAgent(activeAgentId),
      description: agentConfig.description,
      memoryOn: memoryGlobalEnabled && ragEnabled,
      memoryGlobalEnabled,
      ragEnabled,
      toolsSummary: agentToolsSummary,
    },
    model: {
      agentOverride: agentModelOverride,
      pinned,
      configuredPrimary,
      configuredFallbacks,
      effectivePrimary,
    },
    session: {
      chatId,
      chatType,
      scope,
      scopeOverridden,
      contextLine,
      globalToolsSummary,
      scheduledCount,
      configState: configManager.state,
      configError: configManager.error ?? null,
    },
  };
}
