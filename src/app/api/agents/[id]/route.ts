import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';
import { renameAgentInState } from '@/lib/db/agent-state';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json() as { newId?: string };
    if (!body.newId || typeof body.newId !== 'string') {
      return NextResponse.json({ error: 'newId is required' }, { status: 400 });
    }
    agentRegistry.renameAgent(id, body.newId);
    await renameAgentInState(id, body.newId);
    return NextResponse.json({ ok: true, id: body.newId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    agentRegistry.deleteAgent(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
