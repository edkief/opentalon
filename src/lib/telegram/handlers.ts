import type { Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { parse_markdown, toHTML } from '@telegraf/entity';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { llmExecutor } from '../agent';
import { ingestMemory } from '../memory';
import { addMessage, getConversationHistory, clearConversation, clearConversationForAgent, getActiveAgent, setActiveAgent } from '../db';
import { updateJobStatus, getJobById, createResumedJob, canResumeJob, getMaxResumeCount } from '../db/jobs';
import { resolveUserInput, getPendingUserInputsByChatId, getUserInput } from '../db/user-inputs';
import { todoManager } from '../agent';
import { getRegisteredTools, getBuiltInTools, getWorkspaceDir, getSkillsSummary, invalidateSkillsCache } from '../tools';
import { parseModelString, getApiKeyForProvider, resolveModelList } from '../agent/model-resolver';
import { createSpecialistTools } from '../agent/specialist';
import { resolveApproval } from '../agent/hitl';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import type { MemoryScope } from '../memory';
import type { ToolSet } from 'ai';
import { configManager } from '../config';
import { schedulerService } from '../scheduler';
import type { TaskData } from '../scheduler';
import { emitSpecialist, logBus } from '../agent/log-bus';
import type { AppBot } from './bot';
import { agentRegistry } from '../soul';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);

const FALLBACK_ERROR_MESSAGE = "My brain is a bit foggy right now, give me a second...";
const TELEGRAM_MAX_LENGTH = 4096;

// Bot reference for callbacks that run outside a Telegraf context (e.g. job completions)
let _bot: AppBot | null = null;

// Per-chatId Promise chain — serializes all agent calls so job callbacks never
// race with active message processing for the same chat.
const chatQueues = new Map<string, Promise<void>>();

// Per-chat model pin set by /setmodel — overrides config primary + fallbacks.
// Cleared by /resetmodel or process restart.
const chatModelPins = new Map<string, string>();

function enqueueForChat(chatId: string, task: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch((e) => console.error('[Queue]', e))
    .finally(() => {
      if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
    });
  chatQueues.set(chatId, next);
}

/** Returns the current tool allowlist from config (re-read on every call for hot reload). */
function getToolAllowlist(): Set<string> | '*' {
  const cfg = configManager.get().tools;
  const val = cfg?.allowlist ?? process.env.TOOL_ALLOWLIST?.trim();
  if (!val) return new Set();
  if (val === '*') return '*';
  if (Array.isArray(val)) return new Set(val);
  return new Set(String(val).split(',').map((s) => s.trim()).filter(Boolean));
}

/** Returns true if the sender is the configured owner (or no owner is configured). */
function isOwner(userId?: number): boolean {
  const ownerId = configManager.get().telegram?.ownerId ?? process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) return true;
  return String(userId) === String(ownerId);
}

/** Escape HTML entities for safe use in Telegram HTML parse mode. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert agent-generated standard Markdown to Telegram HTML.
 * parse_markdown extracts entities; toHTML serializes them with proper HTML tags
 * and escapes special characters in plain text segments automatically.
 * Falls back to HTML-escaped plain text if parsing fails.
 */
function formatForTelegram(text: string): string {
  try {
    const message = parse_markdown(text);
    return toHTML(message as any);
  } catch (error) {
    console.warn('[Telegram] Formatting failed, sending as plain text:', error);
    return escapeHtml(text);
  }
}

/** Split text into chunks ≤ maxLen, preferring paragraph/line breaks. */
function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Send text to Telegram, splitting into multiple messages if needed. */
async function replyChunked(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const formatted = formatForTelegram(chunk);
    try {
      await ctx.reply(formatted, { parse_mode: 'HTML' });
    } catch (e) {
      console.warn('[WARN] Failed to send as HTML, falling back to plain text:', e);
      await ctx.reply(chunk);
    }
  }
}

/** Send text to a chat by ID (used for job callbacks outside a Telegraf context). */
export async function sendToChat(
  chatId: string,
  text: string,
  formatOrOptions?: 'markdown' | 'html' | { reply_markup?: InlineKeyboard }
): Promise<void> {
  if (!_bot) return;

  let parseMode: 'HTML' | undefined;
  let replyMarkup: InlineKeyboard | undefined;

  if (formatOrOptions && typeof formatOrOptions === 'object' && 'reply_markup' in formatOrOptions) {
    replyMarkup = formatOrOptions.reply_markup;
  } else if (formatOrOptions === 'html') {
    parseMode = 'HTML';
  }

  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const formatted = (formatOrOptions === 'html' || parseMode) ? chunk : formatForTelegram(chunk);
    try {
      await _bot.api.sendMessage(chatId, formatted, { parse_mode: parseMode, reply_markup: replyMarkup });
    } catch {
      await _bot.api.sendMessage(chatId, chunk, { reply_markup: replyMarkup });
    }
  }
}

function getScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
}


async function buildTools(
  ctx: Context,
  chatId: string,
  _scope: MemoryScope,
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

  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(getBuiltInTools({ sendApprovalRequest, telegramChatId: chatId, memoryScope: 'private', sendTelegramMessage: sendToChat })),
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
    }) as any,
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
  } as any);

  const merged = { ...builtInTools, ...mcpTools, send_file }; // MCP overrides on collision

  // Per-agent tool filter — if the agent specifies an allowlist, restrict tools to it.
  const activeAgent = await getActiveAgent(chatId);
  const agentToolFilter = agentRegistry.getSoulManager(activeAgent).getConfig().tools;
  const allTools: ToolSet =
    agentToolFilter && agentToolFilter.length > 0
      ? Object.fromEntries(
          Object.entries(merged).filter(([k]) => (agentToolFilter as string[]).includes(k)),
        )
      : merged;

  const specialistTools = createSpecialistTools(0, allTools, chatId, activeAgent);

  return { ...allTools, ...specialistTools };
}

/**
 * Called by the scheduler when a scheduled task or background specialist job fires.
 * Enqueued via the per-chatId queue so it never interleaves with active message processing.
 * When data.specialistId is set the job originated from spawn_specialist(background:true).
 */
export async function runScheduledTask(data: TaskData): Promise<void> {
  const { chatId, description, specialistId, agentId: taskAgentId, spawningAgentId, parentSpecialistId } = data;
  const isHeartbeat = data.taskId?.startsWith('heartbeat-') && description === '__heartbeat__';
  const activeAgent = taskAgentId ?? await getActiveAgent(chatId);

  // For specialist jobs, get maxStepsUsed from the job record
  let maxStepsOverride: number | undefined;
  if (specialistId) {
    const job = await getJobById(specialistId);
    if (job?.maxStepsUsed) {
      maxStepsOverride = job.maxStepsUsed;
    }
  }

  enqueueForChat(chatId, async () => {
    const startMs = Date.now();

    // Update job status to running (if it's a background specialist job)
    if (specialistId) {
      await updateJobStatus(specialistId, 'running').catch(console.error);
    }

    // Auto-approve all tools — no HITL during automated runs
    const autoApprove = (approvalId: string): Promise<void> => {
      setImmediate(() => resolveApproval(approvalId, true));
      return Promise.resolve();
    };

    const [builtInTools, mcpTools, skillsSummary] = await Promise.all([
      Promise.resolve(getBuiltInTools({ sendApprovalRequest: autoApprove, telegramChatId: chatId, memoryScope: 'private', sendTelegramMessage: sendToChat })),
      getRegisteredTools({ sendApprovalRequest: autoApprove }),
      getSkillsSummary(),
    ]);

    // Build a bot-API-based send_file since there is no Grammy ctx in automated runs
    const send_file = _bot
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
          }) as any,
          execute: async (input: { path: string; caption?: string }) => {
            const ext = path.extname(input.path).toLowerCase();
            const file = new InputFile(input.path);
            const opts = input.caption ? { caption: input.caption } : {};
            try {
              if (IMAGE_EXTS.has(ext)) {
                await _bot!.api.sendPhoto(chatId, file, opts);
              } else if (AUDIO_EXTS.has(ext)) {
                await _bot!.api.sendAudio(chatId, file, opts);
              } else if (VIDEO_EXTS.has(ext)) {
                await _bot!.api.sendVideo(chatId, file, opts);
              } else {
                await _bot!.api.sendDocument(chatId, file, opts);
              }
              return `File sent: ${input.path}`;
            } catch (err) {
              return `Failed to send file: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        } as any)
      : undefined;

    const baseTools: ToolSet = { ...builtInTools, ...mcpTools, ...(send_file ? { send_file } : {}) };

    // If this is a background specialist that was spawned by an agent with sub-agent permissions,
    // provide the spawn_specialist and await_specialists tools at depth=1.
    // createSpecialistTools returns await_specialists only when currentSpecialistId is set,
    // enabling the fork-and-wait pattern without chat-queue deadlocks.
    const agentConfig = agentRegistry.getSoulManager(activeAgent).getConfig();
    const tools: ToolSet = spawningAgentId || (agentConfig.canSpawnSubAgents && agentConfig.allowedSubAgents?.length)
      ? { ...baseTools, ...createSpecialistTools(1, baseTools, chatId, spawningAgentId ?? activeAgent, specialistId) }
      : baseTools;

    const history = specialistId
      ? []
      : await getConversationHistory(chatId, activeAgent, 10);

    let taskMessage: string;
    if (isHeartbeat) {
      const sm = agentRegistry.getSoulManager(activeAgent);
      const checklist = sm.getHeartbeatContent().trim();
      const body = checklist
        ? `Review this checklist:\n\n${checklist}`
        : 'Perform a general status check.';
      taskMessage =
        `[Heartbeat Check-In]\n\n${body}\n\n` +
        `If everything is nominal and nothing needs attention, respond with exactly: HEARTBEAT_OK\n` +
        `Otherwise, report your findings concisely.`;
    } else {
      const label = specialistId ? 'Background Specialist Task' : 'Scheduled Task Triggered';
      taskMessage =
        `[${label}]\n\n` +
        `Task: ${description}\n\n` +
        `Please carry out this task now and report back to the user.`;
    }

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: taskMessage },
    ];

    const skillsContext = skillsSummary
      ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
      : '\n\nNo skills saved yet.';

    let response;
    try {
      response = await llmExecutor.chat({
        messages,
        context: `Today's date: ${new Date().toISOString().slice(0, 10)}. Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()}. This is an automated run — no user is waiting. Complete the task and send a concise summary.${skillsContext}`,
        memoryScope: 'private',
        chatId,
        tools,
        agentId: activeAgent,
        maxSteps: maxStepsOverride,
        specialistId,
      });
    } catch (err) {
      if (specialistId) {
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'error',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
        });
      }
      throw err;
    }

    if (!isChatText(response) || !response.text.trim()) {
      // Job produced no text — mark it completed so it doesn't stay stuck as 'running'
      if (specialistId) {
        await updateJobStatus(specialistId, 'completed', '(no output)').catch(console.error);
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'complete',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: '(no output)',
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: isChatText(response) ? response.provider : undefined,
        });
      }
      return;
    }

    const replyText = response.text.trim();

    // Suppress heartbeat message when agent reports nothing to do
    if (isHeartbeat && replyText === 'HEARTBEAT_OK') return;

    const hitMaxSteps = response.hitMaxSteps ?? false;
    const maxStepsUsed = response.maxStepsUsed;

    if (specialistId) {
      if (hitMaxSteps) {
        // Emit max_steps event
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'max_steps',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: replyText.slice(0, 2_000),
          durationMs: Date.now() - startMs,
          maxStepsUsed,
          canResume: true,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: response.provider,
        });

        // Update job status in DB
        await updateJobStatus(specialistId, 'max_steps_reached', replyText.slice(0, 5_000), undefined, maxStepsUsed);

        // Send notification with inline keyboard for resume
        const keyboard = new InlineKeyboard()
          .text(`Resume with ${maxStepsUsed ?? 15} more steps`, `resume_${specialistId}`)
          .row()
          .text('Resume with 30 more steps', `resume_${specialistId}_30`)
          .row()
          .text('Resume with 50 more steps', `resume_${specialistId}_50`)
          .row()
          .text('Close task', `close_${specialistId}`);

        await sendToChat(chatId, `${replyText}\n\n⏸️ This task hit the step limit. Would you like to resume it?`, { reply_markup: keyboard });
      } else {
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'complete',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: replyText.slice(0, 2_000),
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: response.provider,
        });
        await updateJobStatus(specialistId, 'completed', replyText.slice(0, 5_000));
        await sendToChat(chatId, replyText);
      }
    } else {
      if (hitMaxSteps) {
        const keyboard = new InlineKeyboard()
          .text(`Resume with ${maxStepsUsed ?? 10} more steps`, `resume_main_${maxStepsUsed ?? 10}`)
          .row()
          .text('Resume with 20 more steps', `resume_main_20`)
          .row()
          .text('Resume with 30 more steps', `resume_main_30`)
          .row()
          .text('Close task', `close_main`);

        await sendToChat(chatId, `${replyText}\n\n⏸️ This task hit the step limit. Would you like to resume it?`, { reply_markup: keyboard });
      } else {
        await sendToChat(chatId, isHeartbeat
          ? `💓 **Heartbeat**\n\n${replyText}`
          : `⏰ **Scheduled task complete**\n\n${replyText}`);
      }
    }

    // Persist to DB + memory for scheduled tasks and heartbeats only.
    // Specialists are stateless — their canonical record is the jobs table.
    if (!specialistId) {
      addMessage(chatId, 0, 'user', taskMessage, activeAgent).catch(console.error);
      addMessage(chatId, 0, 'assistant', replyText, activeAgent, {
        inputTokens: response.result?.usage?.inputTokens,
        outputTokens: response.result?.usage?.outputTokens,
        model: response.provider,
      }).catch(console.error);
      ingestMemory({ chatId, scope: 'private', author: 'user', text: taskMessage, agent: activeAgent }).catch(console.error);
      ingestMemory({ chatId, scope: 'private', author: 'exchange', text: `User: ${taskMessage}\nAssistant: ${replyText}`, agent: activeAgent }).catch(console.error);
    }
  });
}


export async function handleListModelsCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;

  const cfg = configManager.get().llm ?? {};
  const primary = cfg.model ?? process.env.LLM_MODEL ?? '(auto-detect)';
  const fallbacks = cfg.fallbacks ?? [];
  const pinned = chatModelPins.get(chatId);

  const lines: string[] = [];
  lines.push(`<b>Primary:</b> <code>${escapeHtml(primary)}</code>${pinned ? '' : ' ✓'}`);
  if (fallbacks.length) {
    lines.push('\n<b>Fallbacks:</b>');
    for (const fb of fallbacks) lines.push(`  • <code>${escapeHtml(fb)}</code>`);
  }
  if (pinned) {
    lines.push(`\n<b>Pinned (this chat):</b> <code>${escapeHtml(pinned)}</code> ✓`);
    lines.push('<i>Use /resetmodel to restore default behaviour.</i>');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

/** Return all configured + auto-detectable models that have a valid API key. */
function getAvailableModels(): string[] {
  const cfg = configManager.get().llm ?? {};
  const configured = [cfg.model, ...(cfg.fallbacks ?? [])].filter((s): s is string => Boolean(s));



  // Custom providers
  const customProviders = configManager.getSecrets().providers?.map(p => p.name) ?? [];
  return configured.filter(s => {
    const parsed = parseModelString(s);
    if (!parsed) return false;
    const knownProviders = ['anthropic', 'openai', 'mistral', 'minimax', 'google'];
    const allKnown = new Set([...knownProviders, ...customProviders]);
    return allKnown.has(parsed.provider) && Boolean(getApiKeyForProvider(parsed.provider));
  });
}

/** Build a flat inline keyboard with one button per model (2 per row) + Cancel. */
function buildFlatModelKeyboard(models: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  models.forEach((m, i) => {
    kb.text(m, `setmodel:pick:${m}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('✖ Cancel', 'setmodel:cancel');
}

/** Build a provider-level keyboard for the two-level menu + Cancel. */
function buildProviderKeyboard(providers: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  providers.forEach((p, i) => {
    kb.text(p, `setmodel:provider:${p}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('✖ Cancel', 'setmodel:cancel');
}

export async function handleSetModelCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.message?.from?.id)) return;

  const modelString = (ctx.match as string | undefined)?.trim();

  // No argument — show interactive selection
  if (!modelString) {
    const models = getAvailableModels();
    if (models.length === 0) {
      await ctx.reply('No configured providers with API keys found. Add API keys to <code>secrets.yaml</code>.', { parse_mode: 'HTML' });
      return;
    }

    // Flat if ≤6 models, two-level otherwise
    if (models.length <= 6) {
      await ctx.reply('Select a model to pin for this chat:', {
        parse_mode: 'HTML',
        reply_markup: buildFlatModelKeyboard(models),
      });
    } else {
      const providers = [...new Set(models.map(m => parseModelString(m)!.provider))];
      await ctx.reply('Select a provider:', {
        parse_mode: 'HTML',
        reply_markup: buildProviderKeyboard(providers),
      });
    }
    return;
  }

  const parsed = parseModelString(modelString);
  if (!parsed) {
    await ctx.reply('Invalid format. Use <code>provider/model</code>, e.g. <code>anthropic/claude-sonnet-4-5</code>.', { parse_mode: 'HTML' });
    return;
  }

  const apiKey = getApiKeyForProvider(parsed.provider);
  const knownProviders = ['anthropic', 'openai', 'mistral', 'minimax', 'google'];
  const customProviders = configManager.getSecrets().providers?.map(p => p.name) ?? [];
  const allKnown = new Set([...knownProviders, ...customProviders]);

  if (!allKnown.has(parsed.provider) || !apiKey) {
    const available = [...allKnown].filter(p => getApiKeyForProvider(p));
    await ctx.reply(
      `Provider <code>${escapeHtml(parsed.provider)}</code> is not configured or has no API key.\n\n` +
      `Configured providers: ${available.map(p => `<code>${escapeHtml(p)}</code>`).join(', ') || 'none'}`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  chatModelPins.set(chatId, modelString);
  await ctx.reply(
    `Model pinned to <code>${escapeHtml(modelString)}</code> for this chat.\nFallbacks are disabled while pinned.\nUse /resetmodel to restore defaults.`,
    { parse_mode: 'HTML' },
  );
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.callbackQuery?.from?.id)) {
    await ctx.answerCallbackQuery('Not authorized.');
    return;
  }

  const data = ctx.callbackQuery?.data ?? '';

  // Provider selected — show models for that provider
  const providerMatch = data.match(/^setmodel:provider:(.+)$/);
  if (providerMatch) {
    const provider = providerMatch[1];
    const models = getAvailableModels().filter(m => parseModelString(m)?.provider === provider);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Select a <b>${escapeHtml(provider)}</b> model:`, {
      parse_mode: 'HTML',
      reply_markup: buildFlatModelKeyboard(models),
    });
    return;
  }

  // Model selected — pin it
  const pickMatch = data.match(/^setmodel:pick:(.+)$/);
  if (pickMatch) {
    const modelString = pickMatch[1];
    chatModelPins.set(chatId, modelString);
    await ctx.answerCallbackQuery(`Pinned: ${modelString}`);
    await ctx.editMessageText(
      `Model pinned to <code>${escapeHtml(modelString)}</code> for this chat.\nFallbacks are disabled while pinned.\nUse /resetmodel to restore defaults.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Cancelled
  if (data === 'setmodel:cancel') {
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }));
  }
}

export async function handleResetModelCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.message?.from?.id)) return;

  const wasPinned = chatModelPins.get(chatId);
  chatModelPins.delete(chatId);

  const cfg = configManager.get().llm ?? {};
  const primary = cfg.model ?? process.env.LLM_MODEL ?? '(auto-detect)';

  if (wasPinned) {
    await ctx.reply(
      `Model pin removed. Back to configured primary: <code>${escapeHtml(primary)}</code>`,
      { parse_mode: 'HTML' },
    );
  } else {
    await ctx.reply(`No model was pinned. Using configured primary: <code>${escapeHtml(primary)}</code>`, { parse_mode: 'HTML' });
  }
}

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

export async function handleMessage(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const message = 'message' in ctx ? ctx.message : undefined;
  const text = message?.text;

  if (!text || !chat) {
    return;
  }

  // Don't respond to commands
  if (text.startsWith('/')) {
    return;
  }

  // Only respond to the configured owner
  if (!isOwner(message?.from?.id)) {
    return;
  }

  // In groups: require a @mention or a reply to one of the bot's messages
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const me = ctx.me;
    const isMention = new RegExp(`@${me.username}`, 'i').test(text);
    const isReplyToBot = message?.reply_to_message?.from?.id === me.id;
    if (!isMention && !isReplyToBot) {
      return;
    }
  }

  const chatId = String(chat.id);
  const messageId = message?.message_id ?? 0;
  const scope = getScope(chat.type);


  ctx.react('👀').catch(() => {});
  ctx.replyWithChatAction('typing').catch(() => {});
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  // User messages are always processed immediately — never queued behind background
  // job callbacks. The chatQueues map is used exclusively for serialising callbacks.
  try {
    const [tools, history, skillsSummary, activeAgent] = await Promise.all([
      buildTools(ctx, chatId, scope),
      (async () => {
        const activeAgentId = await getActiveAgent(chatId);
        return getConversationHistory(chatId, activeAgentId, 20);
      })(),
      getSkillsSummary(),
      getActiveAgent(chatId),
    ]);

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: text },
    ];

    const skillsContext = skillsSummary
      ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
      : '\n\nNo skills saved yet.';

    const response = await llmExecutor.chat({
      messages,
      context: `Today's date: ${new Date().toISOString().slice(0, 10)}. Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()} (use this as the base for all file paths). Skills are stored in ${getWorkspaceDir()}/skills/. Generated files (images, audio, etc.) should be saved to the workspace dir. Shell env vars available in run_command: TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN.${skillsContext}`,
      memoryScope: scope,
      chatId,
      tools,
      agentId: activeAgent,
      modelOverride: chatModelPins.get(chatId),
    });

    if (!isChatText(response)) {
      await ctx.reply(FALLBACK_ERROR_MESSAGE);
      return;
    }

    const replyText = response.text.trim();
    if (!replyText) {
      // Agent finished via tool calls without generating a text summary
      await ctx.reply('✅ Done.');
      return;
    }

    await replyChunked(ctx, replyText);

    // Persist turn to DB (fire and forget)
    addMessage(chatId, messageId, 'user', text, activeAgent).catch(err => {
      console.error('[DB] Failed to store user message:', err);
    });
    addMessage(chatId, messageId, 'assistant', replyText, activeAgent, {
      inputTokens: response.result?.usage?.inputTokens,
      outputTokens: response.result?.usage?.outputTokens,
      model: response.provider,
    }).catch(err => {
      console.error('[DB] Failed to store assistant message:', err);
    });

    // Store messages in memory (fire and forget)
    ingestMemory({ chatId, scope, author: 'user', text, agent: activeAgent }).catch(err => {
      console.error('[Memory] Failed to store user message:', err);
    });

    ingestMemory({ chatId, scope, author: 'exchange', text: `User: ${text}\nAssistant: ${replyText}`, agent: activeAgent }).catch(err => {
      console.error('[Memory] Failed to store exchange:', err);
    });
  } catch (error) {
    console.error('[Telegram Handler] Error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('[Config]')) {
      await ctx.reply(`⚠️ Configuration error — check the dashboard to fix it.\n\n<code>${escapeHtml(msg)}</code>`, { parse_mode: 'HTML' });
    } else if (msg.startsWith('[LLM]')) {
      await ctx.reply(`⚠️ <b>All language models failed.</b>\n\n<pre>${escapeHtml(msg)}</pre>`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(FALLBACK_ERROR_MESSAGE);
    }
  } finally {
    clearInterval(typingInterval);
  }
}

export async function handleApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const match = data.match(/^(approve|deny):(.+)$/);
  if (!match) return;

  const approved = match[1] === 'approve';
  const approvalId = match[2];

  const resolved = resolveApproval(approvalId, approved);

  if (resolved) {
    await ctx.answerCallbackQuery(approved ? '✅ Approved' : '❌ Denied');
  } else {
    await ctx.answerCallbackQuery('⏱️ Request already expired');
  }

  // Remove the inline keyboard from the message
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
}

export async function handleResetCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  const pinned = chatModelPins.get(chatId);
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

export async function handleResumeCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;

  const text = ctx.message?.text;
  if (!text) return;

  // Parse: /resume <job_id> [steps] [--guidance "your guidance here"]
  const parts = text.slice(8).trim().split(' ');
  if (parts.length < 1 || !parts[0]) {
    await ctx.reply(
      `<b>Usage:</b> /resume &lt;job_id&gt; [additional_steps] [--guidance "your guidance"]\n\n` +
      `Examples:\n` +
      `• /resume abc123 - resume with default steps\n` +
      `• /resume abc123 30 - resume with 30 more steps\n` +
      `• /resume abc123 30 --guidance "try a different approach"\n\n` +
      `You can find the job ID from the max steps or completion notification.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Parse --guidance flag
  let guidance: string | undefined;
  const guidanceIndex = parts.indexOf('--guidance');
  if (guidanceIndex !== -1) {
    guidance = parts.slice(guidanceIndex + 1).join(' ');
    parts.splice(guidanceIndex); // Remove --guidance and its value
  }

  const jobId = parts[0];
  const additionalSteps = parts[1] ? parseInt(parts[1], 10) : undefined;

  if (parts[1] && isNaN(additionalSteps!)) {
    await ctx.reply('Invalid number of steps. Please provide a valid number.');
    return;
  }

  const job = await getJobById(jobId);
  if (!job) {
    await ctx.reply(`Job not found: ${jobId}`);
    return;
  }

  // Allow resume from completed or max_steps_reached
  const validStatuses = ['completed', 'max_steps_reached'];
  if (!validStatuses.includes(job.status)) {
    await ctx.reply(`Job ${jobId} is not in a resumable status (current: ${job.status}). Only 'completed' or 'max_steps_reached' jobs can be resumed.`);
    return;
  }

  // Create a resumed job with guidance
  const newJobId = await createResumedJob(job, additionalSteps, guidance);

  // Schedule the resumed job
  await schedulerService.scheduleOnce(newJobId, chatId, job.taskDescription, 0, { specialistId: newJobId });

  // Update original job status
  await updateJobStatus(jobId, 'completed', undefined, 'Resumed');

  let message = `▶️ Resuming task...\n\n` +
    `Original job: ${jobId.slice(0, 8)}...\n` +
    `New job: ${newJobId.slice(0, 8)}...\n` +
    `Additional steps: ${additionalSteps ?? job.maxStepsUsed ?? 15}`;

  if (guidance) {
    message += `\nGuidance: ${guidance}`;
  }

  message += `\n\nThe task will continue in the background.`;

  await ctx.reply(message);
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.callbackQuery?.data) return;

  const data = ctx.callbackQuery.data;

  // Handle different resume patterns
  let jobId: string;
  let additionalSteps: number;

  if (data.startsWith('resume_main_')) {
    // Main agent resume - these don't have a stored job ID in the same way
    // For main agent, we'd need a different mechanism
    await ctx.answerCallbackQuery({ text: 'Main agent resume not yet implemented' });
    return;
  } else if (data.startsWith('resume_')) {
    // Parse: resume_<jobId> or resume_<jobId>_<steps>
    const rest = data.slice(7); // Remove 'resume_'
    const parts = rest.split('_');
    jobId = parts[0];
    additionalSteps = parts[1] ? parseInt(parts[1], 10) : 15;
  } else {
    return;
  }

  await ctx.answerCallbackQuery();

  const job = await getJobById(jobId);
  if (!job) {
    await ctx.editMessageText(`Job not found: ${jobId}`);
    return;
  }

  // Check if job can be resumed (max resume limit)
  const { canResume, reason } = canResumeJob(job);
  if (!canResume) {
    await ctx.editMessageText(`❌ Cannot resume: ${reason}`);
    return;
  }

  // Allow resume from completed or max_steps_reached
  const validStatuses = ['completed', 'max_steps_reached'];
  if (!validStatuses.includes(job.status)) {
    await ctx.editMessageText(`Job ${jobId.slice(0, 8)}... is no longer in a resumable status (${job.status}).`);
    return;
  }

  // Create a resumed job
  const newJobId = await createResumedJob(job, additionalSteps);

  // Schedule the resumed job
  await schedulerService.scheduleOnce(newJobId, chatId, job.taskDescription, 0, { specialistId: newJobId });

  // Update original job status
  await updateJobStatus(jobId, 'completed', undefined, 'Resumed');

  // Update the message to show it's been resumed
  await ctx.editMessageText(
    `▶️ Task resumed!\n\n` +
    `Original job: ${jobId.slice(0, 8)}...\n` +
    `New job: ${newJobId.slice(0, 8)}...\n` +
    `Additional steps: ${additionalSteps}\n\n` +
    `The task will continue in the background.`
  );
}

export async function handleGuidanceCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.callbackQuery?.data) return;

  const data = ctx.callbackQuery.data;

  // Parse: guidance_{inputId}_{option}
  if (!data.startsWith('guidance_')) return;

  const rest = data.slice(9); // Remove 'guidance_'
  const separatorIndex = rest.indexOf('_');
  if (separatorIndex === -1) return;

  const inputId = rest.slice(0, separatorIndex);
  const option = rest.slice(separatorIndex + 1);

  await ctx.answerCallbackQuery();

  // Resolve the user input
  await resolveUserInput(inputId, option);

  await ctx.editMessageText(
    `✅ Guidance received: <b>${escapeHtml(option)}</b>\n\nThe agent will continue with your guidance.`,
    { parse_mode: 'HTML' }
  );
}

/** Handle closing a task that hit max steps */
export async function handleCloseCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.callbackQuery?.data) return;

  const data = ctx.callbackQuery.data;

  // Parse: close_<jobId> or close_main
  if (!data.startsWith('close_')) return;

  const rest = data.slice(6); // Remove 'close_'

  await ctx.answerCallbackQuery();

  if (rest === 'main') {
    // For main agent, just dismiss the message
    await ctx.editMessageText('✅ Task closed.');
  } else {
    // For specialist jobs, update the job status to completed
    const jobId = rest;
    const job = await getJobById(jobId);
    if (job) {
      await updateJobStatus(jobId, 'completed', undefined, 'Closed by user');
      await ctx.editMessageText(`✅ Task closed.`);
    } else {
      await ctx.editMessageText('Task not found.');
    }
  }
}

function setupSkillsWatcher() {
  const skillsDir = path.join(getWorkspaceDir(), 'skills');
  import('node:fs').then((fs) => {
    if (!fs.existsSync(skillsDir)) return;
    try {
      const watcher = fs.watch(skillsDir, { recursive: true }, (eventType, filename) => {
        if (filename && (filename.endsWith('/SKILL.md') || filename.endsWith('.sh'))) {
          console.log(`[Skills] File changed: ${filename}, invalidating cache`);
          invalidateSkillsCache();
        }
      });
      console.log('[Skills] Watching for changes in:', skillsDir);
    } catch (e) {
      console.warn('[Skills] Failed to watch skills directory:', e);
    }
  });
}

export async function setupHandlers(bot: AppBot): Promise<void> {
  _bot = bot;
  await schedulerService.initialize(runScheduledTask);
  setupSkillsWatcher();
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.command('status', handleStatusCommand);
  bot.command('reset', handleResetCommand);
  bot.command('refresh_skills', handleRefreshSkillsCommand);
  bot.command('resume', handleResumeCommand);
  bot.command('listagents', handleListAgentsCommand);
  bot.command('agent', handleAgentCommand);
  bot.command('listmodels', handleListModelsCommand);
  bot.command('setmodel', handleSetModelCommand);
  bot.command('resetmodel', handleResetModelCommand);
  bot.on('message:text', handleMessage);
  bot.callbackQuery(/^(approve|deny):/, handleApprovalCallback);
  bot.callbackQuery(/^setmodel:/, handleModelCallback);
  bot.callbackQuery(/^agent:/, handleAgentCallback);
  bot.callbackQuery(/^resume_/, handleResumeCallback);
  bot.callbackQuery(/^close_/, handleCloseCallback);
  bot.callbackQuery(/^guidance_/, handleGuidanceCallback);

  // Listen for user input request events and send prompts to users
  logBus.on('user-input', async (event) => {
    const { inputId, chatId, prompt, options } = event;

    if (options && options.length > 0) {
      // Send inline keyboard with options
      const keyboard = new InlineKeyboard();
      for (const opt of options) {
        keyboard.text(opt, `guidance_${inputId}_${opt}`);
      }

      await sendToChat(chatId, `🤔 <b>Guidance needed</b>\n\n${prompt}`, { reply_markup: keyboard });
    } else {
      // Send prompt asking for free-text response
      await sendToChat(chatId, `🤔 <b>Guidance needed</b>\n\n${prompt}\n\n<i>Please reply with your guidance.</i>`);
    }
  });
}
