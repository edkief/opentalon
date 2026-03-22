import { NextRequest, NextResponse } from 'next/server';
import { llmExecutor } from '@/lib/agent';
import { isChatText } from '@/lib/agent/types';
import { addMessage, getConversationHistory, getActiveAgent } from '@/lib/db';
import type { Message } from '@/lib/agent/types';

export const dynamic = 'force-dynamic';

const WEB_CHAT_ID = 'web';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, context, chatId: rawChatId, agentId: rawAgentId } = body as {
      message?: string;
      context?: string;
      chatId?: string;
      agentId?: string;
    };

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const chatId = rawChatId?.trim() || WEB_CHAT_ID;
    const agentId = rawAgentId?.trim() || await getActiveAgent(chatId);

    // Load prior conversation history for continuity (scoped to agent)
    const history = await getConversationHistory(chatId, agentId, 20);
    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: message },
    ];

    // Save the user message before generating (so it appears in the stream immediately)
    await addMessage(chatId, 0, 'user', message, agentId);

    const response = await llmExecutor.chat({
      messages,
      context,
      chatId,
      memoryScope: 'private',
      agentId,
    });

    if (!isChatText(response)) {
      return NextResponse.json({ error: 'No response generated' }, { status: 500 });
    }

    await addMessage(chatId, 0, 'assistant', response.text, agentId);

    return NextResponse.json({ text: response.text, chatId });
  } catch (error) {
    console.error('[Chat API] Error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('[Config]')) {
      return NextResponse.json({ error: 'Configuration invalid', detail: msg }, { status: 503 });
    }
    return NextResponse.json({ error: 'Failed to generate response' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Chat API endpoint. POST with { message, chatId? }',
  });
}
