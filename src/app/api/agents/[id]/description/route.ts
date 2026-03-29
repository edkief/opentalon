import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { description, additionalInstructions } = agentRegistry.getSoulManager(id).getConfig();
  return NextResponse.json({ description: description ?? '', additionalInstructions: additionalInstructions ?? '' });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { description?: string; additionalInstructions?: string };
    const trimmedDesc = typeof body.description === 'string' ? body.description.trim() : '';
    const trimmedInstr = typeof body.additionalInstructions === 'string' ? body.additionalInstructions.trim() : '';
    agentRegistry.getSoulManager(id).writeConfig({
      description: trimmedDesc || undefined,
      additionalInstructions: trimmedInstr || undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
