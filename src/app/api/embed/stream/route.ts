/**
 * GET /api/embed/stream?token=&since= — live delivery for an embed conversation.
 *
 * Replays any outbox rows the client has not seen, then streams new ones as they
 * are written, plus coarse progress derived from the agent's step events so the
 * panel can show what the agent is doing during a long turn.
 *
 * Authorised by the stream token from POST /session — a GET has no body, so
 * that token is the only thing naming the chat.
 *
 * Shape (heartbeats, headers) follows src/app/api/logs/stream/route.ts. The
 * X-Accel-Buffering header matters here in particular: this response is relayed
 * through the host application's own reverse proxy.
 */

import type { EmbedOutboxEvent, StepEvent } from '@/lib/agent/log-bus';
import { logBus } from '@/lib/agent/log-bus';
import { readEmbedOutbox } from '@/lib/db/embed';
import { withStreamToken } from '@/lib/embed/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Collapse a step event into something worth showing in a chat panel. Tool names
 * are surfaced; raw model text is not — the reply arrives as an outbox message.
 */
function statusOf(event: StepEvent): string | null {
  const tool = event.toolCalls?.[0]?.toolName;
  if (tool) return `Running ${tool}`;
  if (event.stage === 'thinking') return 'Thinking';
  if (event.stage === 'responding') return 'Writing a reply';
  return null;
}

export async function GET(req: Request) {
  return withStreamToken(req, async ({ chatId, since, cors }) => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        controller.enqueue(encoder.encode(': connected\n\n'));

        const emit = (row: {
          seq: number;
          kind: string;
          role: string;
          content: string;
          format: string;
          turnId?: string | null;
          createdAt: string;
        }) => send('message', row);

        // Attach the live listener BEFORE replaying, buffering what arrives, so
        // a message written between the replay query and the subscription is not
        // lost. Buffered rows are flushed after replay, filtered against the
        // replay high-water mark so nothing is sent twice.
        let replaying = true;
        let replayMax = since;
        const buffered: EmbedOutboxEvent[] = [];

        const forward = (event: EmbedOutboxEvent) =>
          emit({
            seq: event.seq,
            kind: event.kind,
            role: event.role,
            content: event.content,
            format: event.format,
            turnId: event.turnId,
            createdAt: event.createdAt,
          });

        const outboxHandler = (event: EmbedOutboxEvent) => {
          if (event.chatId !== chatId) return;
          if (replaying) {
            buffered.push(event);
            return;
          }
          // Deliberately NOT a high-water-mark check. Two pushes can be assigned
          // sequences 4 and 5 and then commit in the other order; skipping
          // anything "already passed" would drop 4 permanently, since the client
          // advances its cursor to 5 and never asks for it again. Ordering is the
          // client's job — it takes max(seq) as its cursor, so out-of-order
          // arrival is harmless but a dropped row is not.
          if (event.seq <= replayMax) return;
          forward(event);
        };

        const stepHandler = (event: StepEvent) => {
          // StepEvent.sessionId is the chatId (llm-executor.ts:718).
          if (event.sessionId !== chatId) return;
          const status = statusOf(event);
          if (status) send('status', { turnId: event.turnId, status });
        };

        logBus.on('embed', outboxHandler);
        logBus.on('step', stepHandler);

        try {
          // Page through the backlog: a client returning after a long absence can
          // have more waiting than one query returns, and stopping early would
          // strand the middle of the range behind the live cursor.
          for (;;) {
            const page = await readEmbedOutbox(chatId, replayMax, 200);
            if (page.length === 0) break;
            for (const row of page) {
              emit({
                seq: row.seq,
                kind: row.kind,
                role: row.role,
                content: row.content,
                format: row.format,
                turnId: row.turnId,
                createdAt: row.createdAt.toISOString(),
              });
              replayMax = Math.max(replayMax, row.seq);
            }
            if (page.length < 200) break;
          }
        } catch (err) {
          console.error('[embed] Stream replay failed:', err);
          send('error', { message: 'Could not replay missed messages' });
        } finally {
          replaying = false;
          for (const event of buffered.sort((a, b) => a.seq - b.seq)) {
            if (event.seq > replayMax) forward(event);
          }
          buffered.length = 0;
        }

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            closed = true;
          }
        }, 15_000);

        return () => {
          closed = true;
          clearInterval(heartbeat);
          logBus.off('embed', outboxHandler);
          logBus.off('step', stepHandler);
        };
      },
    });

    return new Response(stream, {
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
