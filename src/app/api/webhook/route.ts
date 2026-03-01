import { NextRequest, NextResponse } from 'next/server';
import { createBotFromEnv } from '@/lib/telegram';
import { setupHandlers } from '@/lib/telegram/handlers';

export const dynamic = 'force-dynamic';

// Module-level singleton — survives across requests in the same process
let bot: ReturnType<typeof createBotFromEnv> | null = null;

function getBot() {
  if (!bot) {
    try {
      bot = createBotFromEnv();
      setupHandlers(bot);
    } catch (error) {
      console.error('[Webhook] Failed to create bot:', error);
      return null;
    }
  }
  return bot;
}

export async function POST(req: NextRequest) {
  const botInstance = getBot();

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
