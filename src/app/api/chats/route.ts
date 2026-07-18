import { NextResponse } from 'next/server';
import { desc, eq, max, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { agentRegistry } from '@/lib/soul';
import { configManager } from '@/lib/config';

/** Latest subject for an email: chatId, used as its display title. */
async function getEmailChatSubject(chatId: string): Promise<string | null> {
  const [row] = await db
    .select({ subject: schema.emailMessages.subject })
    .from(schema.emailMessages)
    .where(eq(schema.emailMessages.chatId, chatId))
    .orderBy(desc(schema.emailMessages.createdAt))
    .limit(1);
  return row?.subject?.trim() || null;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ChatChannel = 'web' | 'email' | 'telegram';

interface ChatInfo {
  chatId: string;
  agentId: string;
  /** Legacy composed label (`agent: emoji title`) — still used by other pages. */
  name: string;
  /** Clean display title (no emoji/agent prefix) for structured UIs. */
  title: string;
  channel: ChatChannel;
  /** ISO timestamp of the most recent message in this chat/agent pair. */
  lastActivity: string | null;
  /**
   * Whether the agent has ever replied in this chat. False for threads stored
   * as passive context only (e.g. non-whitelisted email senders) — the picker
   * hides these by default.
   */
  hasAgentResponse: boolean;
}

function channelOf(chatId: string): ChatChannel {
  if (chatId === 'web') return 'web';
  if (chatId.startsWith('email:')) return 'email';
  return 'telegram';
}

async function getTelegramChatName(chatId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      ok: boolean;
      result?: { title?: string; first_name?: string; last_name?: string; username?: string };
    };
    if (!data.ok || !data.result) return null;
    const { title, first_name, last_name, username } = data.result;
    if (title) return title;
    if (first_name || last_name) return [first_name, last_name].filter(Boolean).join(' ');
    if (username) return `@${username}`;
    return null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse<ChatInfo[]>> {
  try {
    // One row per chat/agent pair, most recently active first.
    const lastActivity = max(schema.conversations.createdAt);
    const hasAgentResponse = sql<number>`max(case when ${schema.conversations.role} = 'assistant' then 1 else 0 end)`;
    const rows = await db
      .select({
        chatId: schema.conversations.chatId,
        agentId: schema.conversations.agentId,
        lastActivity,
        hasAgentResponse,
      })
      .from(schema.conversations)
      .groupBy(schema.conversations.chatId, schema.conversations.agentId)
      .orderBy(desc(lastActivity));

    const chatIds = Array.from(new Set(rows.map((r) => r.chatId)));
    // The bot token lives in secrets.yaml first (the dashboard process rarely
    // has it in env); mirror bot-manager's resolution order. Reading only the
    // env var here is why Telegram group names never resolved.
    const token = configManager.getSecrets().telegram?.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '';

    const nameMap = new Map<string, string>();
    await Promise.all(
      chatIds.map(async (chatId) => {
        if (nameMap.has(chatId)) return;
        if (chatId === 'web') {
          nameMap.set(chatId, 'Web Channel');
          return;
        }
        if (chatId.startsWith('email:')) {
          const subject = await getEmailChatSubject(chatId);
          nameMap.set(chatId, subject ?? 'Email thread');
          return;
        }
        // Prefer the Telegram chat/group name; fall back to the raw id only
        // when the name can't be resolved.
        const name = token ? await getTelegramChatName(chatId, token) : null;
        nameMap.set(chatId, name ?? chatId);
      }),
    );

    const channelEmoji: Record<ChatChannel, string> = { web: '', email: '📧 ', telegram: '💬 ' };

    const results: ChatInfo[] = rows.map(({ chatId, agentId, lastActivity, hasAgentResponse }) => {
      const effectiveAgent = agentId ?? agentRegistry.getDefaultAgent();
      const channel = channelOf(chatId);
      const title = nameMap.get(chatId) ?? chatId;
      return {
        chatId,
        agentId: effectiveAgent,
        name: `${effectiveAgent}: ${channelEmoji[channel]}${title}`,
        title,
        channel,
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
        hasAgentResponse: Number(hasAgentResponse) === 1,
      };
    });

    return NextResponse.json(results);
  } catch (err) {
    console.error('[API/chats] GET error:', err);
    return NextResponse.json([]);
  }
}
