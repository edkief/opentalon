import { NextRequest, NextResponse } from 'next/server';
import { getActivePersona, setActivePersona } from '@/lib/db';
import { personaRegistry } from '@/lib/soul';

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (!chatId) {
    return NextResponse.json({ error: 'chatId query param required' }, { status: 400 });
  }
  const personaName = await getActivePersona(chatId);
  return NextResponse.json({ chatId, personaName });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { chatId?: string; personaName?: string };
    if (!body.chatId || !body.personaName) {
      return NextResponse.json({ error: 'chatId and personaName are required' }, { status: 400 });
    }
    if (!personaRegistry.personaExists(body.personaName)) {
      return NextResponse.json({ error: `Persona "${body.personaName}" not found` }, { status: 404 });
    }
    await setActivePersona(body.chatId, body.personaName);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
