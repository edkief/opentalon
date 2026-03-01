import { NextRequest, NextResponse } from 'next/server';
import { createBotFromEnv } from '@/lib/telegram';
import { setupHandlers } from '@/lib/telegram/handlers';
import { addMessage, getConversationHistory } from '@/lib/db';
import { baseAgent } from '@/lib/agent';
import { isChatText } from '@/lib/agent/types';
import type { Message } from '@/lib/agent/types';

export const dynamic = 'force-dynamic';

// Initialize bot
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
    return NextResponse.json(
      { error: 'Bot not initialized' },
      { status: 500 }
    );
  }

  try {
    const body = await req.json();

    // Handle the update through grammY
    await botInstance.handleUpdate(body);

    // Check if this is a message we should process for history
    if (body.message && body.message.text) {
      const chatId = String(body.message.chat.id);
      const messageId = body.message.message_id;
      const text = body.message.text;

      // Skip commands
      if (!text.startsWith('/')) {
        // Save user message
        await addMessage(chatId, messageId, 'user', text);

        // Get response and save it
        try {
          const history = await getConversationHistory(chatId, 5);
          const messages: Message[] = history.map((msg) => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          }));
          messages.push({ role: 'user', content: text });

          const response = await baseAgent.chat({ messages });

          // Save assistant response
          if (isChatText(response)) {
            await addMessage(chatId, messageId + 1, 'assistant', response.text);
          }
        } catch (error) {
          console.error('[Webhook] Failed to process message:', error);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok', message: 'Telegram webhook endpoint' });
}
