import { InlineKeyboard, InputFile } from 'grammy';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { llmExecutor } from '../agent';
import { reconstructTurnMessages } from '../agent/resume';
import { resolveApproval } from '../agent/hitl';
import { createSpecialistTools } from '../agent/specialist';
import { agentRegistry } from '../soul';
import { getBuiltInTools, getRegisteredTools, getWorkspaceDir, getSkillsSummary } from '../tools';
import {
  addMessage,
  getConversationHistory,
  clearPendingTurn,
  incrementTurnAttempts,
  getInflightTurns,
  type PendingTurn,
} from '../db';
import { configManager } from '../config';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import { buildTurnParts } from '../agent/turn-parts';
import { extractUsage } from '../agent/usage';
import { getToolAllowlist, enqueueForChat } from './state';
import { IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS } from './format';
import { sendToChat, getBot } from './send';

/**
 * Startup crash recovery: find every turn still marked in-flight and re-drive
 * it. Called once on boot, after the bot is initialized so replies can be
 * delivered. No-op unless llm.resumeTurnsOnRestart is enabled. Each turn is
 * dispatched onto its own per-chat queue via resumeTurn(), so recovery never
 * blocks startup and recovered turns serialise correctly against live traffic.
 */
export async function recoverPendingTurns(): Promise<void> {
  if (configManager.get().llm?.resumeTurnsOnRestart !== true) return;
  let pending: PendingTurn[];
  try {
    pending = await getInflightTurns();
  } catch (err) {
    console.error('[ResumeTurn] Failed to list in-flight turns on startup:', err);
    return;
  }
  if (pending.length === 0) return;
  console.log(`[ResumeTurn] Found ${pending.length} in-flight turn(s) to recover after restart.`);
  for (const turn of pending) {
    await resumeTurn(turn).catch((err) =>
      console.error(`[ResumeTurn] Failed to dispatch recovery for turn ${turn.turnId}:`, err),
    );
  }
}

/**
 * Re-drives a turn that was in flight when the process died. The user message
 * and every completed step were persisted before the crash; this rebuilds the
 * turn's tools (headless — no live grammY Context), replays the executed steps
 * so the model continues rather than restarts (falling back to a from-scratch
 * re-run when no steps are reconstructable), delivers the reply over the bot
 * API, and clears the recovery record.
 *
 * Runs on the per-chat queue so a recovered turn never interleaves with live
 * message processing for the same chat.
 */
export async function resumeTurn(pending: PendingTurn): Promise<void> {
  const maxAttempts = configManager.get().llm?.resumeTurnsMaxAttempts ?? 3;
  const attempts = await incrementTurnAttempts(pending.turnId);
  if (attempts > maxAttempts) {
    console.error(
      `[ResumeTurn] Turn ${pending.turnId} exceeded ${maxAttempts} recovery attempts — abandoning to avoid a crash loop.`,
    );
    await clearPendingTurn(pending.turnId);
    await sendToChat(
      pending.chatId,
      "⚠️ I was working on your previous request when I restarted, but I couldn't recover it. Please send it again.",
    ).catch(() => {});
    return;
  }

  enqueueForChat(pending.chatId, async () => {
    const { turnId, chatId, agentId, messageId, scope, userContent, modelOverride } = pending;

    if (!agentRegistry.agentExists(agentId)) {
      console.error(`[ResumeTurn] Agent "${agentId}" no longer exists — abandoning turn ${turnId}.`);
      await clearPendingTurn(turnId);
      return;
    }

    console.log(`[ResumeTurn] Resuming turn ${turnId} for chat ${chatId} (attempt ${attempts}/${maxAttempts})`);

    try {
      // Prior conversation, excluding THIS turn's rows — the user message is
      // re-added below and any partial assistant text was never persisted.
      const historyRows = await getConversationHistory(chatId, agentId, 20);
      const history: Message[] = historyRows
        .filter((m) => m.turnId !== turnId)
        .map((m) => ({
          role: m.role as Message['role'],
          content: m.content,
          ...(m.parts ? { parts: m.parts as Message['parts'] } : {}),
        }));

      const messages: Message[] = [...history, { role: 'user', content: userContent }];

      // Rebuild the executed tool activity for this turn (empty ⇒ from-scratch).
      const { messages: resumeMessages, executedSteps } = await reconstructTurnMessages(turnId, chatId);
      console.log(
        `[ResumeTurn] Reconstructed ${executedSteps} executed step(s) for turn ${turnId}` +
          (executedSteps === 0 ? ' — restarting from the original request' : ''),
      );

      const tools = await buildHeadlessTools(chatId, agentId, scope, turnId);
      const skillsSummary = await getSkillsSummary();
      const skillsContext = skillsSummary
        ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
        : '\n\nNo skills saved yet.';

      const response = await llmExecutor.chat({
        messages,
        context: `Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()} (use this as the base for all file paths). Skills are stored in ${getWorkspaceDir()}/skills/. Generated files (images, audio, etc.) should be saved to the workspace dir. Shell env vars available in run_command: TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN.${skillsContext}`,
        memoryScope: scope,
        chatId,
        tools,
        agentId,
        modelOverride: modelOverride ?? undefined,
        turnId,
        userInitiated: true,
        resumeMessages,
      });

      if (!isChatText(response)) {
        console.error(`[ResumeTurn] Turn ${turnId} produced a non-text response — abandoning.`);
        await clearPendingTurn(turnId);
        return;
      }

      const replyText = response.text.trim() || '✅ Done.';
      // Recovered work can be surprising to the user, who saw no reply before the
      // restart — a short prefix explains the delayed answer.
      await sendToChat(chatId, `↩️ Resuming your earlier request:\n\n${replyText}`);

      await addMessage(
        chatId,
        messageId,
        'assistant',
        replyText,
        agentId,
        { ...extractUsage(response.result?.totalUsage ?? response.result?.usage), model: response.provider },
        response.turnId ?? turnId,
        buildTurnParts(response.responseMessages),
      ).catch((err) => console.error('[ResumeTurn] Failed to store assistant message:', err));

      // Only clear the recovery record once the reply is delivered and persisted,
      // so a crash mid-resume is itself recoverable on the next startup.
      await clearPendingTurn(turnId);
      console.log(`[ResumeTurn] Turn ${turnId} resumed and delivered.`);
    } catch (err) {
      // Leave the pending row in place: a transient failure gets another attempt
      // on the next restart (bounded by resumeTurnsMaxAttempts above).
      console.error(`[ResumeTurn] Failed to resume turn ${turnId}:`, err);
    }
  });
}

/**
 * Tool set for a resumed turn, built without a grammY Context. Mirrors
 * buildTools() but routes approval prompts and file sends through the bot API
 * (getBot) instead of ctx — the same headless pattern the scheduled-task path
 * uses. The dangerous-tool approval keyboard still reaches the user, so
 * recovery does not silently auto-run anything the live turn would have gated.
 */
async function buildHeadlessTools(
  chatId: string,
  agentId: string,
  scope: 'private' | 'shared',
  turnId: string,
): Promise<ToolSet> {
  const toolAllowlist = getToolAllowlist();
  const bot = getBot();

  const sendApprovalRequest = async (approvalId: string, toolName: string, input: unknown): Promise<void> => {
    if (toolAllowlist === '*' || toolAllowlist.has(toolName)) {
      setImmediate(() => resolveApproval(approvalId, true));
      return;
    }
    if (!bot) {
      // No channel to ask on — deny rather than block the turn indefinitely.
      setImmediate(() => resolveApproval(approvalId, false));
      return;
    }
    const preview = JSON.stringify(input, null, 2).slice(0, 500);
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${approvalId}`)
      .text('❌ Deny', `deny:${approvalId}`);
    await bot.api.sendMessage(
      chatId,
      `⚠️ Dangerous tool requested (resumed turn)\n\nTool: ${toolName}\nInput:\n${preview}\n\nApprove this action?`,
      { reply_markup: keyboard },
    );
  };

  const agentCfg = agentRegistry.getSoulManager(agentId).getConfig();
  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(
      getBuiltInTools({
        sendApprovalRequest,
        chatId,
        memoryScope: scope,
        agentId,
        toolProfile: agentCfg.toolProfile,
        sendMessage: sendToChat,
        allowedSkills: agentCfg.allowedSkills ?? null,
        allowedWorkflows: agentCfg.allowedWorkflows ?? null,
      }),
    ),
    getRegisteredTools({ sendApprovalRequest }),
  ]);

  const send_file = bot
    ? tool({
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
            if (IMAGE_EXTS.has(ext)) await bot.api.sendPhoto(chatId, file, opts);
            else if (AUDIO_EXTS.has(ext)) await bot.api.sendAudio(chatId, file, opts);
            else if (VIDEO_EXTS.has(ext)) await bot.api.sendVideo(chatId, file, opts);
            else await bot.api.sendDocument(chatId, file, opts);
            return `File sent: ${input.path}`;
          } catch (err) {
            return `Failed to send file: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      })
    : undefined;

  const merged: ToolSet = { ...builtInTools, ...mcpTools, ...(send_file ? { send_file } : {}) };
  const agentToolFilter = agentCfg.tools;
  const allTools: ToolSet =
    agentToolFilter && agentToolFilter.length > 0
      ? Object.fromEntries(Object.entries(merged).filter(([k]) => (agentToolFilter as string[]).includes(k)))
      : merged;

  const specialistTools = createSpecialistTools(0, allTools, chatId, agentId, undefined, undefined, turnId);
  return { ...allTools, ...specialistTools };
}
