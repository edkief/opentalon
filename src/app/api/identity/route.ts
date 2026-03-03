import { NextRequest, NextResponse } from 'next/server';
import { soulManager } from '@/lib/soul';

export async function GET() {
  return NextResponse.json({ content: soulManager.getIdentityContent() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { content?: string };
    if (typeof body.content !== 'string') {
      return NextResponse.json({ error: 'content must be a string' }, { status: 400 });
    }
    soulManager.writeIdentity(body.content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[API/identity] write error:', err);
    return NextResponse.json({ error: 'Failed to save identity' }, { status: 500 });
  }
}
