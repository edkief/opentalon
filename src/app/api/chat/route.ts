import { NextRequest, NextResponse } from 'next/server';
import { baseAgent } from '@/lib/agent';
import type { Message } from '@/lib/agent/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, context } = body;

    if (!message) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    const messages: Message[] = [{ role: 'user', content: message }];

    const response = await baseAgent.chat({
      messages,
      context,
    });

    return NextResponse.json({
      text: response.text,
    });
  } catch (error) {
    console.error('[Chat API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate response' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Chat API endpoint. POST with { message: "your message" }',
  });
}
