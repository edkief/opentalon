import { logBus, getWorkflowHistory, type WorkflowEvent } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send rolling history so late-joining clients can reconstruct current state
      const history = getWorkflowHistory();
      for (const event of history) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          return;
        }
      }

      controller.enqueue(encoder.encode(': connected\n\n'));

      const cleanup = () => {
        clearInterval(heartbeat);
        logBus.off('workflow', handler);
      };

      const handler = (event: WorkflowEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };

      logBus.on('workflow', handler);

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
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
