import { NextRequest, NextResponse } from 'next/server';
import { createBotFromEnv } from '@/lib/telegram';
import { setupHandlers } from '@/lib/telegram/handlers';

export const dynamic = 'force-dynamic';

// Module-level singleton — survives across requests in the same process
let bot: ReturnType<typeof createBotFromEnv> | null = null;
let botInitPromise: Promise<ReturnType<typeof createBotFromEnv> | null> | null = null;

async function getBot(): Promise<ReturnType<typeof createBotFromEnv> | null> {
  if (bot) return bot;
  if (botInitPromise) return botInitPromise;
  botInitPromise = (async () => {
    try {
      const instance = createBotFromEnv();
      await setupHandlers(instance);
      bot = instance;
      return instance;
    } catch (error) {
      console.error('[Webhook] Failed to create bot:', error);
      botInitPromise = null;
      return null;
    }
  })();
  return botInitPromise;
}

export async function POST(req: NextRequest) {
  const botInstance = await getBot();

  if (!botInstance) {
    return NextResponse.json({ error: 'Bot not initialized' }, { status: 500 });
  }

  try {
    const body = await req.json();
    await botInstance.handleUpdate(body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok', message: 'Telegram webhook endpoint' });
}
