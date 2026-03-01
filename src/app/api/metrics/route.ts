import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { sql, count } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Messages by day (last 30 days)
    const byDay = await db
      .select({
        day: sql<string>`date_trunc('day', ${schema.conversations.createdAt})::date::text`,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '30 days'`)
      .groupBy(sql`date_trunc('day', ${schema.conversations.createdAt})`)
      .orderBy(sql`date_trunc('day', ${schema.conversations.createdAt})`);

    // Messages by role
    const byRole = await db
      .select({
        role: schema.conversations.role,
        count: count(),
      })
      .from(schema.conversations)
      .groupBy(schema.conversations.role);

    // Top 10 chat IDs by message count
    const byChatId = await db
      .select({
        chatId: schema.conversations.chatId,
        count: count(),
      })
      .from(schema.conversations)
      .groupBy(schema.conversations.chatId)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    return NextResponse.json({ byDay, byRole, byChatId });
  } catch (error) {
    console.error('[Metrics] Error:', error);
    return NextResponse.json({ error: 'Failed to load metrics' }, { status: 500 });
  }
}
