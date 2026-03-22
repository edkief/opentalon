import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';
import type { SoulConfig } from '@/lib/soul/soul-manager';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const sm = agentRegistry.getSoulManager(id);
  const { ragEnabled } = sm.getConfig();
  return NextResponse.json({ ragEnabled: ragEnabled ?? true });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { ragEnabled?: boolean };
    const config: Partial<SoulConfig> = {
      ragEnabled: typeof body.ragEnabled === 'boolean' ? body.ragEnabled : undefined,
    };
    agentRegistry.getSoulManager(id).writeConfig(config);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
