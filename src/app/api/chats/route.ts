import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { agentRegistry } from '@/lib/soul';

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
        const name = token ? await getTelegramChatName(chatId, token) : null;
        nameMap.set(chatId, name ?? chatId);
      }),
    );

    const results: ChatInfo[] = rows.map(({ chatId, agentId }) => {
      const effectiveAgent = agentId ?? agentRegistry.getDefaultAgent();
      const baseName = nameMap.get(chatId) ?? chatId;
      const label =
        chatId === 'web'
          ? `${effectiveAgent}: ${baseName}`
          : `${effectiveAgent}: ${baseName} (${chatId})`;
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
