import { NextRequest, NextResponse } from 'next/server';
import { workflowEngine } from '@/lib/workflow/engine';

export const dynamic = 'force-dynamic';

// POST /api/workflow/run/[runId]/cancel
export async function POST(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  await workflowEngine.cancelRun(runId);
  return NextResponse.json({ ok: true });
}
