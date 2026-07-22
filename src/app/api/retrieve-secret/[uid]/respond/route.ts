import { NextRequest, NextResponse } from 'next/server';
import { getSecretRequest, markSecretRequest } from '@/lib/db/secret-requests';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid } = await params;

  const request = await getSecretRequest(uid);

  if (!request) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (request.status !== 'pending') {
    return NextResponse.json({ error: 'Already responded' }, { status: 409 });
  }

  if (new Date() > request.expiresAt) {
    return NextResponse.json({ error: 'Expired' }, { status: 410 });
  }

  const body = await req.json().catch(() => ({}));
  const action: string = body.action;

  if (action !== 'submit' && action !== 'decline' && action !== 'guide') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  if (action === 'submit' && !body.value?.trim()) {
    return NextResponse.json({ error: 'Value is required' }, { status: 400 });
  }

  if (action === 'guide' && !body.message?.trim()) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 });
  }

  // Set status (+ transient value) in the DB. The blocking request_secret tool
  // polls this row from its own process and resumes the SAME turn that asked for
  // the secret — no pg-boss handoff, no separate agent run that could race the
  // still-running requester. See src/lib/tools/communication.ts (request_secret).
  if (action === 'submit') {
    await markSecretRequest(uid, 'fulfilled', body.value);
  } else if (action === 'guide') {
    await markSecretRequest(uid, 'guided', body.message);
  } else {
    await markSecretRequest(uid, 'declined');
  }

  return NextResponse.json({ ok: true });
}
