import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { canSpawnSubAgents, allowedSubAgents, injectAvailableAgents } = agentRegistry.getSoulManager(id).getConfig();
  return NextResponse.json({
    canSpawnSubAgents: canSpawnSubAgents ?? false,
    allowedSubAgents: allowedSubAgents ?? null,
    injectAvailableAgents: injectAvailableAgents ?? false,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { canSpawnSubAgents?: boolean; allowedSubAgents?: string[] | null; injectAvailableAgents?: boolean };
    agentRegistry.getSoulManager(id).writeConfig({
      canSpawnSubAgents: typeof body.canSpawnSubAgents === 'boolean' ? body.canSpawnSubAgents : undefined,
      allowedSubAgents: body.allowedSubAgents === null
        ? undefined
        : Array.isArray(body.allowedSubAgents)
          ? body.allowedSubAgents.filter(Boolean)
          : undefined,
      injectAvailableAgents: typeof body.injectAvailableAgents === 'boolean' ? body.injectAvailableAgents : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
