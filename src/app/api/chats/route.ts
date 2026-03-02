import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ChatInfo {
  chatId: string;
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
      .selectDistinct({ chatId: schema.conversations.chatId })
      .from(schema.conversations)
      .orderBy(schema.conversations.chatId);

    const chatIds = rows.map((r) => r.chatId);
    const token = process.env.TELEGRAM_BOT_TOKEN ?? '';

    const results = await Promise.all(
      chatIds.map(async (chatId): Promise<ChatInfo> => {
        if (chatId === 'web') return { chatId, name: 'Web Channel' };
        const name = token ? await getTelegramChatName(chatId, token) : null;
        return { chatId, name: name ?? chatId };
      }),
    );

    return NextResponse.json(results);
  } catch (err) {
    console.error('[API/chats] GET error:', err);
    return NextResponse.json([]);
  }
}
