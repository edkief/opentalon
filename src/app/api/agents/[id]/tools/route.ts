import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { tools } = agentRegistry.getSoulManager(id).getConfig();
  // null means "all tools allowed" (no restriction)
  return NextResponse.json({ tools: tools ?? null });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { tools: string[] | null };
    // null = unrestricted, [] = no tools, [...] = specific set
    const tools = body.tools === null ? undefined : Array.isArray(body.tools) ? body.tools.filter(Boolean) : undefined;
    agentRegistry.getSoulManager(id).writeConfig({ tools });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
