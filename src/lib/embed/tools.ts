/**
 * Embed tool set — mirrors src/lib/email/tools.ts.
 *
 * Differences from the other channels:
 *  - The tool profile can be narrowed per client, so the same agent can be
 *    broader over Telegram than it is inside somebody else's web page.
 *  - There is no interactive approval UI. `dangerousTools: 'deny'` (the default)
 *    posts a notice into the chat and denies; `'allowlist'` auto-approves what
 *    is already in tools.allowlist and denies the rest.
 *  - send_file is omitted — an embedded panel has no file transport.
 */

import type { ToolSet } from 'ai';
import { getActiveAgent } from '../db';
import { getRegisteredTools, getBuiltInTools } from '../tools';
import { createSpecialistTools } from '../agent/specialist';
import { resolveApproval } from '../agent/hitl';
import { agentRegistry } from '../soul';
import type { MemoryScope } from '../memory';
import { getToolAllowlist } from '../telegram/state';
import { sendToChat } from '../channels/registry';
import { applyAgentToolFilter } from '../tools/apply-agent-filter';
import { deliverToEmbedChat } from './send';
import type { ResolvedEmbedClient } from './config';

export async function buildEmbedTools(
  chatId: string,
  client: ResolvedEmbedClient,
  agentId: string,
  scope: MemoryScope,
  turnJobIds?: Set<string>,
  turnId?: string,
): Promise<ToolSet> {
  // Re-read on each call so hot-reload applies immediately.
  const toolAllowlist = getToolAllowlist();

  const sendApprovalRequest = async (
    approvalId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> => {
    const allowlisted = toolAllowlist === '*' || toolAllowlist.has(toolName);

    if (client.dangerousTools === 'allowlist' && allowlisted) {
      // setImmediate defers until after waitForApproval() registers the entry.
      setImmediate(() => resolveApproval(approvalId, true));
      return;
    }

    const preview = JSON.stringify(input, null, 2).slice(0, 500);
    await deliverToEmbedChat(
      chatId,
      `⚠️ **Dangerous tool requested**\n\n**Tool:** \`${toolName}\`\n**Input:**\n\`\`\`json\n${preview}\n\`\`\`\n\n` +
        `This surface has no approval prompt, so I skipped it. Approve it from the dashboard, or ask me again from Telegram or the dashboard chat.`,
      { kind: 'notice', role: 'system', turnId },
    ).catch((err) => console.error('[embed] Failed to post approval notice:', err));

    setImmediate(() => resolveApproval(approvalId, false));
  };

  const agentCfg = agentRegistry.getSoulManager(agentId).getConfig();

  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(
      getBuiltInTools({
        sendApprovalRequest,
        chatId,
        memoryScope: scope,
        agentId,
        // A per-client profile beats the agent's own, which beats the global
        // default — the client is the most specific statement of what this
        // surface should be able to do.
        toolProfile: client.toolProfile ?? agentCfg.toolProfile,
        sendMessage: sendToChat,
        allowedSkills: agentCfg.allowedSkills ?? null,
        allowedWorkflows: agentCfg.allowedWorkflows ?? null,
        allowedSubAgents: agentCfg.allowedSubAgents ?? null,
      }),
    ),
    getRegisteredTools({ sendApprovalRequest }),
  ]);

  const merged = { ...builtInTools, ...mcpTools }; // MCP overrides on collision

  // Per-agent tool filter — shared with telegram/email/web so every channel
  // applies the per-agent allowlist identically.
  const allTools = applyAgentToolFilter(merged, agentCfg.tools);

  const specialistTools = createSpecialistTools(0, allTools, chatId, agentId, undefined, turnJobIds, turnId);

  return { ...allTools, ...specialistTools };
}

/** Resolve which agent answers on this chat: the client's pin, else the chat's active agent. */
export async function resolveEmbedAgent(chatId: string, client: ResolvedEmbedClient): Promise<string> {
  if (client.agentId && agentRegistry.agentExists(client.agentId)) return client.agentId;
  return getActiveAgent(chatId);
}
