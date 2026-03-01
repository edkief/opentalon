import { logBus, type SpecialistEvent } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // initial heartbeat
      controller.enqueue(encoder.encode(': connected\n\n'));

      const handler = (event: SpecialistEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      logBus.on('specialist', handler);

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': ping\n\n'));
      }, 15_000);

      return () => {
        clearInterval(heartbeat);
        logBus.off('specialist', handler);
      };
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
