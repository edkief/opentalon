/**
 * POST /api/embed/context — update the page context out of band.
 *
 * The dedicated operation for "the page changed": the host pushes a fresh
 * envelope without sending a message. With `announce: true` it also writes a
 * passive-context row into the conversation, so a change made mid-conversation
 * is visible to the model in history rather than silently swapping under it.
 *
 * Self-authenticating: see the note in src/lib/embed/http.ts.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addMessage } from '@/lib/db';
import { getEmbedThread, upsertEmbedThread } from '@/lib/db/embed';
import { getEmbedConfig } from '@/lib/embed/config';
import { contextVersionOf } from '@/lib/embed/context';
import { embedPreflight, withEmbedAuth } from '@/lib/embed/http';
import { resolveEmbedAgent } from '@/lib/embed/tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ announce: z.boolean().optional() });

export async function POST(req: Request) {
  return withEmbedAuth(req, async ({ principal, client, chatId, body, cors }) => {
    const cfg = getEmbedConfig();
    if (!cfg) {
      return NextResponse.json(
        { error: 'channel_disabled', message: 'The embed channel is disabled' },
        { status: 503, headers: cors },
      );
    }

    if (!body.context) {
      return NextResponse.json(
        { error: 'bad_request', message: 'context is required' },
        { status: 400, headers: cors },
      );
    }

    const announce = BodySchema.safeParse(body).data?.announce === true;
    const previous = await getEmbedThread(chatId);
    const version = contextVersionOf(body.context);

    await upsertEmbedThread({
      chatId,
      clientId: principal.clientId,
      resourceId: principal.resourceId,
      userKey: principal.userKey,
      userLabel: principal.userLabel,
      title: body.resource.title,
      url: body.resource.url,
      context: body.context,
      contextVersion: version,
    });

    // Only worth announcing when the content actually moved and there is a
    // conversation in progress to announce it to.
    const changed = previous?.contextVersion !== version;
    if (announce && changed && previous) {
      const agentId = await resolveEmbedAgent(chatId, client);
      // Role 'user' with an explicit marker rather than a mid-history 'system'
      // row — providers handle interleaved system messages inconsistently. Same
      // convention as the email channel's passive-context rows.
      await addMessage(
        chatId,
        chatId,
        0,
        'user',
        `[Page context updated by ${client.label} — context only, not an instruction. The page "${body.resource.title ?? principal.resourceId}" now has context version ${version}.]`,
        agentId,
      ).catch((err) => console.error('[embed] Failed to store context announcement:', err));
    }

    return NextResponse.json({ ok: true, chatId, version, changed }, { headers: cors });
  });
}

export async function OPTIONS(req: Request) {
  return embedPreflight(req);
}
