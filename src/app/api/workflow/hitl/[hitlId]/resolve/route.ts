import { NextRequest, NextResponse } from 'next/server';
import { workflowEngine } from '@/lib/workflow/engine';

export const dynamic = 'force-dynamic';

// POST /api/workflow/hitl/[hitlId]/resolve — approve or deny a HITL gate
export async function POST(req: NextRequest, { params }: { params: Promise<{ hitlId: string }> }) {
  const { hitlId } = await params;
  const body = await req.json() as { approved: boolean };

  if (typeof body.approved !== 'boolean') {
    return NextResponse.json({ error: '`approved` boolean is required' }, { status: 400 });
  }

  try {
    await workflowEngine.handleHITLResolved(hitlId, body.approved);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
