/**
 * Email tool set — mirrors src/lib/telegram/tools.ts minus grammY.
 *
 * Differences from Telegram:
 *  - Outbound goes through the channel registry (`sendToChat`), which routes the
 *    email: chatId back to sendEmailToChat.
 *  - There is no interactive approval UI. Allowlisted tools auto-approve (same
 *    setImmediate/resolveApproval trick as Telegram); a non-allowlisted
 *    dangerous tool emails the request then auto-DENIES with an explanation.
 *    Approval-by-email-reply is a deferred v1 enhancement.
 *  - send_file is omitted (attachments deferred both directions).
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

export async function buildEmailTools(
  chatId: string,
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
    // Auto-approve allowlisted tools without prompting.
    // setImmediate defers until after waitForApproval() registers the entry.
    if (toolAllowlist === '*' || toolAllowlist.has(toolName)) {
      setImmediate(() => resolveApproval(approvalId, true));
      return;
    }

    // No interactive approval over email in v1: notify, then auto-deny.
    const preview = JSON.stringify(input, null, 2).slice(0, 500);
    await sendToChat(
      chatId,
      `⚠️ **Dangerous tool requested**\n\n**Tool:** \`${toolName}\`\n**Input:**\n\`\`\`json\n${preview}\n\`\`\`\n\n` +
        `I can't run this over email in this version (no interactive approval), so I've skipped it. ` +
        `Approve it from the dashboard, or ask me again via Telegram/web.`,
    );
    setImmediate(() => resolveApproval(approvalId, false));
  };

  // Resolve active agent config before building tools (needed for skill/workflow allowlists).
  const activeAgent = await getActiveAgent(chatId);
  const agentCfg = agentRegistry.getSoulManager(activeAgent).getConfig();

  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(getBuiltInTools({
      sendApprovalRequest,
      chatId,
      memoryScope: scope,
      sendMessage: sendToChat,
      allowedSkills: agentCfg.allowedSkills ?? null,
      allowedWorkflows: agentCfg.allowedWorkflows ?? null,
      allowedSubAgents: agentCfg.allowedSubAgents ?? null,
    })),
    getRegisteredTools({ sendApprovalRequest }),
  ]);

  // send_file omitted: attachments are deferred for email (TODO).
  const merged = { ...builtInTools, ...mcpTools }; // MCP overrides on collision

  // Per-agent tool filter — mirror telegram/tools.ts.
  const agentToolFilter = agentCfg.tools;
  const mcpToolNames = new Set(Object.keys(mcpTools));
  const allTools: ToolSet =
    agentToolFilter && agentToolFilter.length > 0
      ? Object.fromEntries(
          Object.entries(merged).filter(([k]) => (agentToolFilter as string[]).includes(k) || mcpToolNames.has(k)),
        )
      : merged;

  const specialistTools = createSpecialistTools(0, allTools, chatId, activeAgent, undefined, turnJobIds, turnId);

  return { ...allTools, ...specialistTools };
}
