import { NextRequest, NextResponse } from 'next/server';
import { agentRegistry, AGENT_EXECUTORS, HARNESS_TRUST_LEVELS, MIN_HARNESS_TIMEOUT_MS, MAX_HARNESS_TIMEOUT_MS } from '@/lib/soul';
import type { AgentExecutor, HarnessTrust, SoulConfig } from '@/lib/soul';
import { checkPi, resolvePiConfig } from '@/lib/harness/pi';
import { harnessWorkdir } from '@/lib/agent/harness-specialist';

/** What runs this agent's specialist tasks (#68), what pi may do unasked (#70), and whether pi is usable here. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const { executor, workdir, harnessTimeoutMs, harnessTrust } = agentRegistry.getSoulManager(id).getConfig();
  const pi = resolvePiConfig();
  const check = pi.enabled ? await checkPi(pi.binary) : undefined;
  return NextResponse.json({
    executor: executor ?? 'native',
    workdir: workdir ?? null,
    harnessTimeoutMs: harnessTimeoutMs ?? null,
    harnessTrust: harnessTrust ?? 'gate',
    resolvedWorkdir: harnessWorkdir({ workdir }),
    pi: { enabled: pi.enabled, ok: check?.ok ?? false, version: check?.version ?? null, detail: check?.detail ?? null },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { executor?: string; workdir?: string | null; harnessTimeoutMs?: number | null; harnessTrust?: string };
    if (body.executor !== undefined && !(AGENT_EXECUTORS as readonly string[]).includes(body.executor)) {
      return NextResponse.json({ error: `executor must be one of ${AGENT_EXECUTORS.join(', ')}` }, { status: 400 });
    }
    if (body.harnessTrust !== undefined && !(HARNESS_TRUST_LEVELS as readonly string[]).includes(body.harnessTrust)) {
      return NextResponse.json({ error: `harnessTrust must be one of ${HARNESS_TRUST_LEVELS.join(', ')}` }, { status: 400 });
    }
    const timeout = body.harnessTimeoutMs;
    if (timeout !== undefined && timeout !== null && (!Number.isInteger(timeout) || timeout < MIN_HARNESS_TIMEOUT_MS || timeout > MAX_HARNESS_TIMEOUT_MS)) {
      return NextResponse.json({ error: `harnessTimeoutMs must be a whole number of milliseconds between ${MIN_HARNESS_TIMEOUT_MS} and ${MAX_HARNESS_TIMEOUT_MS}` }, { status: 400 });
    }
    // Only the fields sent are changed; null (or a blank workdir) clears one, back to the
    // agent workspace and the global specialist timeout.
    const update: Partial<SoulConfig> = {};
    if (body.executor !== undefined) update.executor = body.executor as AgentExecutor;
    if (body.workdir !== undefined) update.workdir = typeof body.workdir === 'string' && body.workdir.trim() ? body.workdir.trim() : undefined;
    if (timeout !== undefined) update.harnessTimeoutMs = timeout ?? undefined;
    if (body.harnessTrust !== undefined) update.harnessTrust = body.harnessTrust as HarnessTrust;
    agentRegistry.getSoulManager(id).writeConfig(update);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
