import type { Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { tool } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { baseAgent } from '../agent';
import { ingestMemory } from '../memory';
import { addMessage, getConversationHistory, clearConversation } from '../db';
import { getRegisteredTools, getBuiltInTools, getWorkspaceDir } from '../tools';
import { createSpawnSpecialistTool } from '../agent/specialist';
import { resolveApproval } from '../agent/hitl';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import type { MemoryScope } from '../memory';
import type { ToolSet } from 'ai';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);

const FALLBACK_ERROR_MESSAGE = "My brain is a bit foggy right now, give me a second...";
const TELEGRAM_MAX_LENGTH = 4096;

/** Parse TOOL_ALLOWLIST env var. Returns '*' for allow-all, or a Set of tool names. */
function getToolAllowlist(): Set<string> | '*' {
  const val = process.env.TOOL_ALLOWLIST?.trim();
  if (!val) return new Set();
  if (val === '*') return '*';
  return new Set(val.split(',').map((s) => s.trim()).filter(Boolean));
}

const toolAllowlist = getToolAllowlist();

// Telegram HTML supports only: b, i, u, s, code, pre, a, blockquote, tg-spoiler
const TELEGRAM_ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
const TAG_ALIASES: Record<string, string> = { strong: 'b', em: 'i', ins: 'u', del: 's', strike: 's' };

/**
 * Convert agent-generated HTML to the limited subset Telegram accepts.
 * Unsupported block tags are converted to plain-text equivalents;
 * all other unknown tags are stripped (content preserved).
 */
function sanitizeTelegramHtml(html: string): string {
  let s = html;

  // Headings → bold + newline
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, c) => `<b>${c.trim()}</b>\n`);
  // Line breaks
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Paragraphs
  s = s.replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n');
  // Lists
  s = s.replace(/<\/?(ul|ol)\s*>/gi, '');
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');

  // Normalize remaining tags, tracking open counts so we never emit
  // an orphaned close tag (which Telegram rejects with 400).
  const openCounts: Record<string, number> = {};

  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, rawName) => {
    const isClosing = match.startsWith('</');
    const name = rawName.toLowerCase();
    const canonical = TAG_ALIASES[name] ?? name;

    if (!TELEGRAM_ALLOWED_TAGS.has(canonical)) return '';

    if (isClosing) {
      if ((openCounts[canonical] ?? 0) > 0) {
        openCounts[canonical]--;
        return `</${canonical}>`;
      }
      return ''; // orphaned close tag — skip it
    }

    // <a> is only valid with an href; skip both open and future close if missing
    if (canonical === 'a') {
      const hrefMatch = match.match(/href="([^"]*)"/);
      if (!hrefMatch) return '';
      openCounts['a'] = (openCounts['a'] ?? 0) + 1;
      return `<a href="${hrefMatch[1]}">`;
    }

    openCounts[canonical] = (openCounts[canonical] ?? 0) + 1;
    return `<${canonical}>`;
  });

  // Auto-close any tags the model left open (prevents Telegram parse errors)
  for (const [tag, count] of Object.entries(openCounts)) {
    if (count > 0) s += `</${tag}>`.repeat(count);
  }

  return s.replace(/\n{3,}/g, '\n\n').trim();
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
    const sanitized = sanitizeTelegramHtml(chunk);
    try {
      await ctx.reply(sanitized, { parse_mode: 'HTML' });
    } catch (e) {
      console.warn('[WARN] Failed to send as HTML, falling back to plain text:', e);
      await ctx.reply(sanitized.replace(/<[^>]*>/g, ''));
    }
  }
}

function getScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
}

async function buildTools(
  ctx: Context,
  chatId: string,
): Promise<ToolSet> {
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
      `⚠️ *Dangerous tool requested*\n\n*Tool:* \`${toolName}\`\n*Input:*\n\`\`\`json\n${preview}\n\`\`\`\n\nApprove this action?`,
      { parse_mode: 'Markdown', reply_markup: keyboard },
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
  const spawnSpecialist = createSpawnSpecialistTool(0, allTools);

  return { ...allTools, spawn_specialist: spawnSpecialist };
}

export async function handleStartCommand(ctx: Context): Promise<void> {
  await ctx.reply("Hello! I'm OpenPincer, your AI assistant. How can I help you today?");
}

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const helpText = `<b>OpenPincer</b> — your AI assistant with agency.

<b>Bot commands</b>
/start — start a conversation
/help — show this message

<b>Built-in capabilities</b>
- <b>Terminal</b> — run shell commands (<i>requires approval</i>)
- <b>Skill library</b> — save, list, run, and delete named commands
- <b>Specialist agents</b> — delegate complex tasks to a focused sub-agent

<b>Skill management</b> (just ask in plain language)
- "save a skill called ping: <code>ping -c 3 1.1.1.1</code>"
- "list my skills"
- "run the ping skill"
- "delete the ping skill"

<b>MCP tools</b> are loaded automatically if MCP servers are configured.

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

  // Check if this is a group chat and we were mentioned
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const me = ctx.me;
    const mentionRegex = new RegExp(`@${me.username}`, 'i');
    if (!mentionRegex.test(text)) {
      return;
    }
  }

  const chatId = String(chat.id);
  const scope = getScope(chat.type);

  try {
    const tools = await buildTools(ctx, chatId);

    // Load persistent conversation history from DB
    const history = await getConversationHistory(chatId, 20);
    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: text },
    ];

    const messageId = message?.message_id ?? 0;

    const response = await baseAgent.chat({
      messages,
      context: `Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()} (use this as the base for all file paths). Skills are stored in ${getWorkspaceDir()}/skills/. Generated files (images, audio, etc.) should be saved to the workspace dir. Shell env vars available in run_command: TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN.`,
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
    await ctx.reply(FALLBACK_ERROR_MESSAGE);
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

export function setupHandlers(bot: import('./bot').AppBot): void {
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.command('clear', handleClearCommand);
  bot.on('message:text', handleMessage);
  bot.callbackQuery(/^(approve|deny):/, handleApprovalCallback);
}
