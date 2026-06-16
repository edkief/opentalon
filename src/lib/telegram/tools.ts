import type { Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { getActiveAgent } from '../db';
import { getRegisteredTools, getBuiltInTools } from '../tools';
import { createSpecialistTools } from '../agent/specialist';
import { resolveApproval } from '../agent/hitl';
import { agentRegistry } from '../soul';
import type { MemoryScope } from '../memory';
import { IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS, escapeHtml } from './format';
import { getToolAllowlist } from './state';
import { sendToChat } from './send';

export async function buildTools(
  ctx: Context,
  chatId: string,
  _scope: MemoryScope,
  turnJobIds?: Set<string>,
  turnId?: string,
): Promise<ToolSet> {
  // Re-read on each call so hot-reload applies immediately
  const toolAllowlist = getToolAllowlist();

  const sendApprovalRequest = async (
    approvalId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> => {
    // Auto-approve allowlisted tools without prompting the user.
    // setImmediate defers until after waitForApproval() registers the entry.
    if (toolAllowlist === '*' || toolAllowlist.has(toolName)) {
      setImmediate(() => resolveApproval(approvalId, true));
      return;
    }

    const preview = JSON.stringify(input, null, 2).slice(0, 500);
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${approvalId}`)
      .text('❌ Deny', `deny:${approvalId}`);

    await ctx.reply(
      `⚠️ <b>Dangerous tool requested</b>\n\n<b>Tool:</b> <code>${escapeHtml(toolName)}</code>\n<b>Input:</b>\n<pre><code class="language-json">${escapeHtml(preview)}</code></pre>\n\nApprove this action?`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  };

  // Resolve active agent config before building tools (needed for skill/workflow allowlists)
  const activeAgent = await getActiveAgent(chatId);
  const agentCfg = agentRegistry.getSoulManager(activeAgent).getConfig();

  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(getBuiltInTools({
      sendApprovalRequest,
      telegramChatId: chatId,
      memoryScope: 'private',
      sendTelegramMessage: sendToChat,
      allowedSkills: agentCfg.allowedSkills ?? null,
      allowedWorkflows: agentCfg.allowedWorkflows ?? null,
    })),
    getRegisteredTools({ sendApprovalRequest }),
  ]);

  const send_file = tool({
    description:
      'Send a local file to the current Telegram chat. ' +
      'Images (.jpg/.jpeg/.png/.gif/.webp) are displayed inline as photos. ' +
      'Audio (.mp3/.ogg/.wav/.m4a/.flac/.aac/.opus) is playable inline. ' +
      'Video (.mp4/.mov/.mkv/.webm) is playable inline. ' +
      'All other formats are sent as downloadable documents.',
    inputSchema: z.object({
      path: z.string().describe('Absolute path to the local file to send'),
      caption: z.string().optional().describe('Optional caption shown below the file'),
    }),
    execute: async (input: { path: string; caption?: string }) => {
      const ext = path.extname(input.path).toLowerCase();
      const file = new InputFile(input.path);
      const opts = input.caption ? { caption: input.caption } : {};
      try {
        if (IMAGE_EXTS.has(ext)) {
          await ctx.replyWithPhoto(file, opts);
        } else if (AUDIO_EXTS.has(ext)) {
          await ctx.replyWithAudio(file, opts);
        } else if (VIDEO_EXTS.has(ext)) {
          await ctx.replyWithVideo(file, opts);
        } else {
          await ctx.replyWithDocument(file, opts);
        }
        return `File sent: ${input.path}`;
      } catch (err) {
        return `Failed to send file: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  const merged = { ...builtInTools, ...mcpTools, send_file }; // MCP overrides on collision

  // Per-agent tool filter — if the agent specifies an allowlist, restrict built-in tools to it.
  // MCP tools always pass through; they are managed via config.yaml and will be individually
  // selectable in the UI in a future iteration.
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
