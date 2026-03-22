import { logBus } from '@/lib/agent/log-bus';
import type { StepEvent } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send a heartbeat comment immediately to establish the connection
      controller.enqueue(encoder.encode(': connected\n\n'));

      const handler = (event: StepEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected
        }
      };

      logBus.on('step', handler);

      // Heartbeat every 15s to keep the connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(heartbeat);
          logBus.off('step', handler);
        }
      }, 15_000);

      return () => {
        clearInterval(heartbeat);
        logBus.off('step', handler);
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
