import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET() {
  const agents = agentRegistry.listAgents();
  return NextResponse.json(agents);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { id?: string };
    if (!body.id || typeof body.id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    agentRegistry.createAgent(body.id);
    return NextResponse.json({ ok: true, id: body.id });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
