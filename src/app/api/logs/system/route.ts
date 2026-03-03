import { logBus, getLogHistory } from '@/lib/agent/log-bus';
import type { LogEvent } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Client disconnected
        }
      };

      // Replay rolling buffer for late-joining clients (oldest → newest)
      for (const event of getLogHistory()) {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      }

      // Initial heartbeat after buffer flush
      enqueue(': connected\n\n');

      const handler = (event: LogEvent) => {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      logBus.on('log', handler);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(heartbeat);
          logBus.off('log', handler);
        }
      }, 15_000);

      return () => {
        clearInterval(heartbeat);
        logBus.off('log', handler);
      };
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
