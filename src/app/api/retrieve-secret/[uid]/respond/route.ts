import { NextRequest, NextResponse } from 'next/server';
import { getSecretRequest, markSecretRequest } from '@/lib/db/secret-requests';
import { schedulerService } from '@/lib/scheduler';

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

  await markSecretRequest(uid, action === 'submit' ? 'fulfilled' : 'declined');

  const description =
    action === 'submit'
      ? `[Secret Request Fulfilled]\n\nThe user provided the requested secret for "${request.name}".\n\nSecret: ${body.value}`
      : action === 'guide'
        ? `[Secret Request — User Guidance]\n\nInstead of providing the secret for "${request.name}", the user sent you the following instructions:\n\n${body.message}`
        : `[Secret Request Declined]\n\nThe user declined to provide the secret for "${request.name}".`;

  // Hand off to the bot process via pg-boss one-off queue (0s delay = run immediately).
  // The bot's ONE_OFF_QUEUE worker has _bot initialised and can sendToChat.
  // Direct runScheduledTask() would fail here because _bot is null in Next.js.
  schedulerService
    .scheduleOnce(`secret-${uid}`, request.chatId, description, 0)
    .catch((err) => console.error('[retrieve-secret] scheduleOnce failed:', err));

  return NextResponse.json({ ok: true });
}
