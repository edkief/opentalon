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

        // Replay first, and track the high-water mark so a row that arrives
        // between the replay query and the listener attaching is not sent twice.
        let delivered = since;
        try {
          const backlog = await readEmbedOutbox(chatId, since, 200);
          for (const row of backlog) {
            send('message', {
              seq: row.seq,
              kind: row.kind,
              role: row.role,
              content: row.content,
              format: row.format,
              turnId: row.turnId,
              createdAt: row.createdAt.toISOString(),
            });
            delivered = Math.max(delivered, row.seq);
          }
        } catch (err) {
          console.error('[embed] Stream replay failed:', err);
          send('error', { message: 'Could not replay missed messages' });
        }

        const outboxHandler = (event: EmbedOutboxEvent) => {
          if (event.chatId !== chatId || event.seq <= delivered) return;
          delivered = event.seq;
          send('message', {
            seq: event.seq,
            kind: event.kind,
            role: event.role,
            content: event.content,
            format: event.format,
            turnId: event.turnId,
            createdAt: event.createdAt,
          });
        };

        const stepHandler = (event: StepEvent) => {
          // StepEvent.sessionId is the chatId (llm-executor.ts:718).
          if (event.sessionId !== chatId) return;
          const status = statusOf(event);
          if (status) send('status', { turnId: event.turnId, status });
        };

        logBus.on('embed', outboxHandler);
        logBus.on('step', stepHandler);

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
