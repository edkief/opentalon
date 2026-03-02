import type { Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { parse_markdown, toHTML } from '@telegraf/entity';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { baseAgent } from '../agent';
import { ingestMemory } from '../memory';
import { addMessage, getConversationHistory, clearConversation } from '../db';
import { getRegisteredTools, getBuiltInTools, getWorkspaceDir, getSkillsSummary } from '../tools';
import { createSpawnSpecialistTool } from '../agent/specialist';
import { resolveApproval } from '../agent/hitl';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import type { MemoryScope } from '../memory';
import type { ToolSet } from 'ai';
import { configManager } from '../config';
import { schedulerService } from '../scheduler';
import type { AppBot } from './bot';

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
async function sendToChat(chatId: string, text: string): Promise<void> {
  if (!_bot) return;
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const formatted = formatForTelegram(chunk);
    try {
      await _bot.api.sendMessage(chatId, formatted, { parse_mode: 'HTML' });
    } catch {
      await _bot.api.sendMessage(chatId, chunk);
    }
  }
}

function getScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
}

/**
 * Called when a background specialist job completes. Runs through the per-chatId
 * queue so it never interleaves with active message processing.
 */
async function handleJobCallback(
  chatId: string,
  jobId: string,
  taskDescription: string,
  result: string,
  scope: MemoryScope,
): Promise<void> {
  const history = await getConversationHistory(chatId, 20);

  // Auto-approve all tools — no HITL prompts during async callbacks
  const autoApprove = (approvalId: string): Promise<void> => {
    setImmediate(() => resolveApproval(approvalId, true));
    return Promise.resolve();
  };

  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(getBuiltInTools({ sendApprovalRequest: autoApprove, telegramChatId: chatId, memoryScope: scope })),
    getRegisteredTools({ sendApprovalRequest: autoApprove }),
  ]);
  // No send_file (no ctx available), no spawn_specialist (avoid chaining)
  const tools: ToolSet = { ...builtInTools, ...mcpTools };

  const jobMessage =
    `[Background Job Complete — ID: ${jobId}]\n\n` +
    `Task: ${taskDescription}\n\n` +
    `Result:\n${result}\n\n` +
    `Please present these findings to the user and take any appropriate follow-up actions.`;

  const messages: Message[] = [
    ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
    { role: 'user', content: jobMessage },
  ];

  const response = await baseAgent.chat({ messages, chatId, tools, memoryScope: scope, maxSteps: 10 });

  if (!isChatText(response) || !response.text.trim()) return;

  const replyText = response.text.trim();
  await sendToChat(chatId, replyText);

  // Persist (fire-and-forget)
  addMessage(chatId, 0, 'user', jobMessage).catch(console.error);
  addMessage(chatId, 0, 'assistant', replyText).catch(console.error);
  ingestMemory({ chatId, scope, author: 'assistant', text: replyText }).catch(console.error);
}

async function buildTools(
  ctx: Context,
  chatId: string,
  scope: MemoryScope,
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
    Promise.resolve(getBuiltInTools({ sendApprovalRequest, telegramChatId: chatId, memoryScope: 'private' })),
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

  const allTools = { ...builtInTools, ...mcpTools, send_file }; // MCP overrides on collision

  const onJobComplete = (jobId: string, taskDescription: string, result: string) => {
    enqueueForChat(chatId, () => handleJobCallback(chatId, jobId, taskDescription, result, scope));
  };

  const spawnSpecialist = createSpawnSpecialistTool(0, allTools, chatId, onJobComplete);

  return { ...allTools, spawn_specialist: spawnSpecialist };
}

/**
 * Called by the scheduler when a scheduled task fires. Enqueued via the per-chatId
 * queue so it never interleaves with active message processing.
 */
export async function runScheduledTask(
  chatId: string,
  _taskId: string,
  description: string,
): Promise<void> {
  enqueueForChat(chatId, async () => {
    // Auto-approve all tools — no HITL during scheduled runs
    const autoApprove = (approvalId: string): Promise<void> => {
      setImmediate(() => resolveApproval(approvalId, true));
      return Promise.resolve();
    };

    const [builtInTools, mcpTools] = await Promise.all([
      Promise.resolve(getBuiltInTools({ sendApprovalRequest: autoApprove, telegramChatId: chatId, memoryScope: 'private' })),
      getRegisteredTools({ sendApprovalRequest: autoApprove }),
    ]);
    const tools: ToolSet = { ...builtInTools, ...mcpTools };

    const history = await getConversationHistory(chatId, 10);

    const taskMessage =
      `[Scheduled Task Triggered]\n\n` +
      `Task: ${description}\n\n` +
      `Please carry out this task now and report back to the user.`;

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: taskMessage },
    ];

    const response = await baseAgent.chat({
      messages,
      context: `Today's date: ${new Date().toISOString().slice(0, 10)}. Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()}. This is an automated scheduled task run — no user is waiting. Complete the task and send a concise summary.`,
      memoryScope: 'private',
      chatId,
      tools,
      maxSteps: 10,
    });

    if (!isChatText(response) || !response.text.trim()) return;

    const replyText = response.text.trim();
    await sendToChat(chatId, `⏰ **Scheduled task complete**\n\n${replyText}`);

    // Persist to DB + memory (fire-and-forget)
    addMessage(chatId, 0, 'user', taskMessage).catch(console.error);
    addMessage(chatId, 0, 'assistant', replyText).catch(console.error);
    ingestMemory({ chatId, scope: 'private', author: 'assistant', text: replyText }).catch(console.error);
  });
}

export async function handleStartCommand(ctx: Context): Promise<void> {
  await ctx.reply("Hello! I'm OpenPincer, your AI assistant. How can I help you today?");
}

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const helpText = `**OpenPincer** — your AI assistant with agency.

**Bot commands**
/start — start a conversation
/help — show this message
/clear — clear conversation history

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
    const [tools, history, skillsSummary] = await Promise.all([
      buildTools(ctx, chatId, scope),
      getConversationHistory(chatId, 20),
      getSkillsSummary(),
    ]);

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: text },
    ];

    const skillsContext = skillsSummary
      ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
      : '\n\nNo skills saved yet.';

    const response = await baseAgent.chat({
      messages,
      context: `Today's date: ${new Date().toISOString().slice(0, 10)}. Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()} (use this as the base for all file paths). Skills are stored in ${getWorkspaceDir()}/skills/. Generated files (images, audio, etc.) should be saved to the workspace dir. Shell env vars available in run_command: TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN.${skillsContext}`,
      memoryScope: scope,
      chatId,
      tools,
      maxSteps: 10,
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
    addMessage(chatId, messageId, 'user', text).catch(err => {
      console.error('[DB] Failed to store user message:', err);
    });
    addMessage(chatId, messageId, 'assistant', replyText).catch(err => {
      console.error('[DB] Failed to store assistant message:', err);
    });

    // Store messages in memory (fire and forget)
    ingestMemory({ chatId, scope, author: 'user', text }).catch(err => {
      console.error('[Memory] Failed to store user message:', err);
    });

    ingestMemory({ chatId, scope, author: 'assistant', text: replyText }).catch(err => {
      console.error('[Memory] Failed to store assistant message:', err);
    });
  } catch (error) {
    console.error('[Telegram Handler] Error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('[Config]')) {
      await ctx.reply(`⚠️ Configuration error — check the dashboard to fix it.\n\n<code>${escapeHtml(msg)}</code>`, { parse_mode: 'HTML' });
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

export async function handleClearCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  await clearConversation(chatId);
  await ctx.reply('🧹 Conversation history cleared.');
}

export function setupHandlers(bot: AppBot): void {
  _bot = bot;
  schedulerService.initialize(runScheduledTask).catch(console.error);
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.command('clear', handleClearCommand);
  bot.on('message:text', handleMessage);
  bot.callbackQuery(/^(approve|deny):/, handleApprovalCallback);
}
