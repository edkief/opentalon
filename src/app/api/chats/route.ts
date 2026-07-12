import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { agentRegistry } from '@/lib/soul';

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

interface ChatInfo {
  chatId: string;
  agentId: string;
  name: string;
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
    const rows = await db
      .selectDistinct({
        chatId: schema.conversations.chatId,
        agentId: schema.conversations.agentId,
      })
      .from(schema.conversations)
      .orderBy(schema.conversations.chatId, schema.conversations.agentId);

    const chatIds = Array.from(new Set(rows.map((r) => r.chatId)));
    const token = process.env.TELEGRAM_BOT_TOKEN ?? '';

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
          nameMap.set(chatId, subject ? `📧 ${subject}` : '📧 Email thread');
          return;
        }
        // Prefer the Telegram chat/group name; fall back to the raw id only when
        // the name can't be resolved. Prefix with an icon so channels are
        // visually distinguishable in the dropdown, like emails (📧).
        const name = token ? await getTelegramChatName(chatId, token) : null;
        nameMap.set(chatId, `💬 ${name ?? chatId}`);
      }),
    );

    const results: ChatInfo[] = rows.map(({ chatId, agentId }) => {
      const effectiveAgent = agentId ?? agentRegistry.getDefaultAgent();
      const baseName = nameMap.get(chatId) ?? chatId;
      const label = `${effectiveAgent}: ${baseName}`;
      return {
        chatId,
        agentId: effectiveAgent,
        name: label,
      };
    });

    return NextResponse.json(results);
  } catch (err) {
    console.error('[API/chats] GET error:', err);
    return NextResponse.json([]);
  }
}
