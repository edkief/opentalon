import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry } from '@/lib/soul';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { allowedSkills, injectSkills } = agentRegistry.getSoulManager(id).getConfig();
  return NextResponse.json({
    allowedSkills: allowedSkills ?? null,
    injectSkills: injectSkills ?? false,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { allowedSkills?: string[] | null; injectSkills?: boolean };
    agentRegistry.getSoulManager(id).writeConfig({
      allowedSkills: body.allowedSkills === null
        ? undefined
        : Array.isArray(body.allowedSkills)
          ? body.allowedSkills.filter(Boolean)
          : undefined,
      injectSkills: typeof body.injectSkills === 'boolean' ? body.injectSkills : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
