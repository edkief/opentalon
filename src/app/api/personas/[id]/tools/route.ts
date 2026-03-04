import { NextRequest, NextResponse } from 'next/server';
import { personaRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!personaRegistry.personaExists(id)) {
    return NextResponse.json({ error: 'Persona not found' }, { status: 404 });
  }
  const { tools } = personaRegistry.getSoulManager(id).getConfig();
  // null means "all tools allowed" (no restriction)
  return NextResponse.json({ tools: tools ?? null });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!personaRegistry.personaExists(id)) {
    return NextResponse.json({ error: 'Persona not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { tools: string[] | null };
    // null = unrestricted, [] = no tools, [...] = specific set
    const tools = body.tools === null ? undefined : Array.isArray(body.tools) ? body.tools.filter(Boolean) : undefined;
    personaRegistry.getSoulManager(id).writeConfig({ tools });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
