/**
 * POST /api/embed/session — open (or resume) a conversation for a host user.
 *
 * Called when the chat panel mounts. Returns the derived chatId, a short-lived
 * stream token (the only way a GET can name a chat), the current outbox cursor,
 * and enough history for the panel to render the conversation it is rejoining.
 *
 * Self-authenticating: see the note in src/lib/embed/http.ts.
 */

import { NextResponse } from 'next/server';
import { getConversationHistory } from '@/lib/db';
import { getEmbedThread, latestEmbedOutboxSeq, upsertEmbedThread } from '@/lib/db/embed';
import { mintStreamToken } from '@/lib/embed/auth';
import { getEmbedConfig } from '@/lib/embed/config';
import { contextVersionOf } from '@/lib/embed/context';
import { embedPreflight, withEmbedAuth } from '@/lib/embed/http';
import { resolveEmbedAgent } from '@/lib/embed/tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  return withEmbedAuth(req, async ({ principal, client, chatId, body, cors }) => {
    const cfg = getEmbedConfig();
    if (!cfg) {
      return NextResponse.json(
        { error: 'channel_disabled', message: 'The embed channel is disabled' },
        { status: 503, headers: cors },
      );
    }

    const context = body.context ?? undefined;
    await upsertEmbedThread({
      chatId,
      clientId: principal.clientId,
      resourceId: principal.resourceId,
      userKey: principal.userKey,
      userLabel: principal.userLabel,
      title: body.resource.title,
      url: body.resource.url,
      // Only touch context when the host actually sent one — a session open with
      // no envelope must not wipe what a previous /context call established.
      ...(context ? { context, contextVersion: contextVersionOf(context) } : {}),
    });

    const agentId = await resolveEmbedAgent(chatId, client);
    const [thread, cursor, history] = await Promise.all([
      getEmbedThread(chatId),
      latestEmbedOutboxSeq(chatId),
      getConversationHistory(chatId, agentId, cfg.historyLimit),
    ]);

    const stream = mintStreamToken(client, chatId);

    return NextResponse.json(
      {
        chatId,
        agentId,
        cursor,
        streamToken: stream.token,
        expiresAt: stream.expiresAt,
        contextVersion: thread?.contextVersion ?? null,
        history: history.map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
        })),
      },
      { headers: cors },
    );
  });
}

export async function OPTIONS(req: Request) {
  return embedPreflight(req);
}
