import { NextRequest, NextResponse } from 'next/server';
import { personaRegistry } from '@/lib/soul';
import type { SoulConfig } from '@/lib/soul/soul-manager';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!personaRegistry.personaExists(id)) {
    return NextResponse.json({ error: 'Persona not found' }, { status: 404 });
  }
  const sm = personaRegistry.getSoulManager(id);
  const { model, fallbacks } = sm.getConfig();
  return NextResponse.json({ model: model ?? null, fallbacks: fallbacks ?? [] });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!personaRegistry.personaExists(id)) {
    return NextResponse.json({ error: 'Persona not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { model?: string | null; fallbacks?: string[] };
    const config: Partial<SoulConfig> = {
      model: body.model ?? undefined,
      fallbacks: Array.isArray(body.fallbacks) ? body.fallbacks.filter(Boolean) : undefined,
    };
    personaRegistry.getSoulManager(id).writeConfig(config);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
