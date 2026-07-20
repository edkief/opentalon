import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, desc, eq, lt } from 'drizzle-orm';

// Every scalar column of `conversations` — everything except the heavy `parts`
// jsonb (the full assistant tool-call parts + tool-result messages replayed
// into the model prompt). The thought stream rebuilds its user/tool/assistant
// structure from the lightweight /api/logs/steps summary, so it never needs
// `parts`; omitting it keeps the initial history payload small.
const LIGHT_COLUMNS = {
  id: schema.conversations.id,
  chatId: schema.conversations.chatId,
  messageId: schema.conversations.messageId,
  role: schema.conversations.role,
  content: schema.conversations.content,
  inputTokens: schema.conversations.inputTokens,
  outputTokens: schema.conversations.outputTokens,
  cacheReadTokens: schema.conversations.cacheReadTokens,
  cacheWriteTokens: schema.conversations.cacheWriteTokens,
  reasoningTokens: schema.conversations.reasoningTokens,
  model: schema.conversations.model,
  agentId: schema.conversations.agentId,
  turnId: schema.conversations.turnId,
  active: schema.conversations.active,
  createdAt: schema.conversations.createdAt,
} as const;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
  const chatId = searchParams.get('chatId') ?? undefined;
  const agentId = searchParams.get('agentId') ?? undefined;
  const beforeId = searchParams.get('before') ? parseInt(searchParams.get('before')!, 10) : undefined;
  // Full tool-call details (the `parts` jsonb) are heavy and lazily loaded, so
  // they are excluded unless a caller explicitly opts in with ?full=1.
  const full = ['1', 'true'].includes(searchParams.get('full') ?? '');

  try {
    const base = full
      ? db.select().from(schema.conversations)
      : db.select(LIGHT_COLUMNS).from(schema.conversations);

    const chatCondition = chatId && agentId
      ? and(eq(schema.conversations.chatId, chatId), eq(schema.conversations.agentId, agentId))
      : chatId
        ? eq(schema.conversations.chatId, chatId)
        : undefined;
    const cursorCondition = beforeId !== undefined ? lt(schema.conversations.id, beforeId) : undefined;
    const whereClause = chatCondition && cursorCondition
      ? and(chatCondition, cursorCondition)
      : chatCondition ?? cursorCondition;

    const rows = await (whereClause ? base.where(whereClause) : base)
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
