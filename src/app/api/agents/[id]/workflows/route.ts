import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { allowedWorkflows, injectWorkflows } = agentRegistry.getSoulManager(id).getConfig();
  return NextResponse.json({
    allowedWorkflows: allowedWorkflows ?? null,
    injectWorkflows: injectWorkflows ?? false,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { allowedWorkflows?: string[] | null; injectWorkflows?: boolean };
    agentRegistry.getSoulManager(id).writeConfig({
      allowedWorkflows: body.allowedWorkflows === null
        ? undefined
        : Array.isArray(body.allowedWorkflows)
          ? body.allowedWorkflows.filter(Boolean)
          : undefined,
      injectWorkflows: typeof body.injectWorkflows === 'boolean' ? body.injectWorkflows : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
