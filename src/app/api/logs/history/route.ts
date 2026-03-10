import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, desc, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
  const chatId = searchParams.get('chatId') ?? undefined;
  const personaId = searchParams.get('personaId') ?? undefined;

  try {
    const base = db
      .select()
      .from(schema.conversations);

    const rows = await (
      chatId && personaId
        ? base
            .where(
              and(
                eq(schema.conversations.chatId, chatId),
                eq(schema.conversations.personaId, personaId),
              ),
            )
        : chatId
          ? base.where(eq(schema.conversations.chatId, chatId))
          : base
    )
      .orderBy(desc(schema.conversations.createdAt))
      .limit(limit);

    return NextResponse.json(rows.reverse());
  } catch (err) {
    console.error('[API/logs/history] error:', err);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}

/** Return the distinct chat IDs known to the DB (for the selector). */
export async function POST() {
  try {
    const rows = await db
      .selectDistinct({ chatId: schema.conversations.chatId })
      .from(schema.conversations)
      .orderBy(schema.conversations.chatId);
    return NextResponse.json(rows.map((r) => r.chatId));
  } catch (err) {
    console.error('[API/logs/history] chatIds error:', err);
    return NextResponse.json([], { status: 500 });
  }
}
