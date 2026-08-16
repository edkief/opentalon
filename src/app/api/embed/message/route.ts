/**
 * POST /api/embed/message — send a user message into an embed conversation.
 *
 * Returns 202 as soon as the turn is queued. An agent turn with tools routinely
 * runs far longer than a host proxy will hold a request open, so the reply is
 * delivered through the outbox (SSE or polling), not this response.
 *
 * Self-authenticating: see the note in src/lib/embed/http.ts.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { claimEmbedInbound, latestEmbedOutboxSeq, upsertEmbedThread } from '@/lib/db/embed';
import { getEmbedConfig } from '@/lib/embed/config';
import { contextVersionOf } from '@/lib/embed/context';
import { embedPreflight, withEmbedAuth } from '@/lib/embed/http';
import { enqueueEmbedTurn } from '@/lib/embed/process-message';
import { consumeEmbedRate } from '@/lib/embed/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  message: z.string().min(1),
  clientMessageId: z.string().min(1).max(200).optional(),
});

export async function POST(req: Request) {
  return withEmbedAuth(req, async ({ principal, client, chatId, body, cors }) => {
    const cfg = getEmbedConfig();
    if (!cfg) {
      return NextResponse.json(
        { error: 'channel_disabled', message: 'The embed channel is disabled' },
        { status: 503, headers: cors },
      );
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400, headers: cors },
      );
    }

    const message = parsed.data.message.trim();
    if (!message) {
      return NextResponse.json(
        { error: 'bad_request', message: 'message is empty' },
        { status: 400, headers: cors },
      );
    }
    if (message.length > cfg.maxMessageChars) {
      return NextResponse.json(
        { error: 'too_large', message: `message exceeds ${cfg.maxMessageChars} characters` },
        { status: 413, headers: cors },
      );
    }

    const rate = consumeEmbedRate(chatId, client.rateLimitPerMinute);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many messages; slow down' },
        { status: 429, headers: { ...cors, 'Retry-After': String(rate.retryAfterSec) } },
      );
    }

    // Refresh the thread's descriptors before the turn reads them, so a page
    // renamed or re-published since the last message is described correctly.
    const context = body.context ?? undefined;
    await upsertEmbedThread({
      chatId,
      clientId: principal.clientId,
      resourceId: principal.resourceId,
      userKey: principal.userKey,
      userLabel: principal.userLabel,
      title: body.resource.title,
      url: body.resource.url,
      ...(context ? { context, contextVersion: contextVersionOf(context) } : {}),
    });

    const turnId = crypto.randomUUID();

    // Idempotency: a host proxy that timed out and retried must not run a second
    // turn over the same history.
    if (parsed.data.clientMessageId) {
      const claim = await claimEmbedInbound(chatId, parsed.data.clientMessageId, turnId);
      if (!claim.fresh) {
        return NextResponse.json(
          { chatId, turnId: claim.turnId, cursor: await latestEmbedOutboxSeq(chatId), duplicate: true },
          { status: 202, headers: cors },
        );
      }
    }

    const cursor = await latestEmbedOutboxSeq(chatId);
    enqueueEmbedTurn({ chatId, client, message, turnId, userLabel: principal.userLabel });

    return NextResponse.json({ chatId, turnId, cursor }, { status: 202, headers: cors });
  });
}

export async function OPTIONS(req: Request) {
  return embedPreflight(req);
}
