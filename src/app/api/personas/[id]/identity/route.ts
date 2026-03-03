import { NextRequest, NextResponse } from 'next/server';
import { personaRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!personaRegistry.personaExists(id)) {
    return NextResponse.json({ error: 'Persona not found' }, { status: 404 });
  }
  const sm = personaRegistry.getSoulManager(id);
  return NextResponse.json({ content: sm.getIdentityContent() });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!personaRegistry.personaExists(id)) {
    return NextResponse.json({ error: 'Persona not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { content?: string };
    if (typeof body.content !== 'string') {
      return NextResponse.json({ error: 'content must be a string' }, { status: 400 });
    }
    personaRegistry.getSoulManager(id).writeIdentity(body.content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
