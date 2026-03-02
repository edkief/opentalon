import { logBus, type SpecialistEvent } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // initial heartbeat
      controller.enqueue(encoder.encode(': connected\n\n'));

      const cleanup = () => {
        clearInterval(heartbeat);
        logBus.off('specialist', handler);
      };

      const handler = (event: SpecialistEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };

      logBus.on('specialist', handler);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          cleanup();
        }
      }, 15_000);

      return cleanup;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
