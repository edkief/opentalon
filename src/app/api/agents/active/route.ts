import { NextRequest, NextResponse } from 'next/server';
import { getActiveAgent, setActiveAgent } from '@/lib/db';
import { agentRegistry } from '@/lib/soul';

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (!chatId) {
    return NextResponse.json({ error: 'chatId query param required' }, { status: 400 });
  }
  const agentName = await getActiveAgent(chatId);
  return NextResponse.json({ chatId, agentName });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { chatId?: string; agentName?: string };
    if (!body.chatId || !body.agentName) {
      return NextResponse.json({ error: 'chatId and agentName are required' }, { status: 400 });
    }
    if (!agentRegistry.agentExists(body.agentName)) {
      return NextResponse.json({ error: `Agent "${body.agentName}" not found` }, { status: 404 });
    }
    await setActiveAgent(body.chatId, body.agentName);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
