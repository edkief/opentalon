/**
 * GET /api/embed/messages?token=&since= — polling fallback for the outbox.
 *
 * Same data as /stream, without the long-lived connection. Useful when the host
 * proxy buffers responses (which breaks SSE) or when the panel would rather not
 * hold a socket open.
 *
 * Authorised by the stream token from POST /session.
 */

import { NextResponse } from 'next/server';
import { latestEmbedOutboxSeq, readEmbedOutbox } from '@/lib/db/embed';
import { withStreamToken } from '@/lib/embed/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return withStreamToken(req, async ({ chatId, since, cors }) => {
    const rows = await readEmbedOutbox(chatId, since, 200);
    // Report the chat's true high-water mark, not just the last row returned, so
    // a client that hits the page limit knows more is waiting.
    const cursor = await latestEmbedOutboxSeq(chatId);

    return NextResponse.json(
      {
        chatId,
        cursor,
        hasMore: rows.length > 0 && rows[rows.length - 1].seq < cursor,
        messages: rows.map((row) => ({
          seq: row.seq,
          kind: row.kind,
          role: row.role,
          content: row.content,
          format: row.format,
          turnId: row.turnId,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      { headers: cors },
    );
  });
}
