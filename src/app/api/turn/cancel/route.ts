import { NextRequest, NextResponse } from 'next/server';
import { turnCancellation, type TurnCancelMode } from '@/lib/agent/cancellation';

/**
 * Cancel the turn currently running for a chat — the Thought Stream's Stop
 * button, and the dashboard counterpart of Telegram's `/cancel`.
 *
 * The registry is in-process, which is fine here for the same reason the SSE
 * step stream is: the Telegram bot is started from `instrumentation.ts` inside
 * this Next.js process, so the turn being watched and the registry being
 * signalled are the same one.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { chatId?: string; mode?: TurnCancelMode };
    const chatId = body.chatId?.trim();

    if (!chatId) {
      return NextResponse.json({ error: 'Missing chatId' }, { status: 400 });
    }

    const mode: TurnCancelMode = body.mode === 'force' ? 'force' : 'graceful';
    const outcome = turnCancellation.request(chatId, mode);

    return NextResponse.json(outcome);
  } catch (error) {
    console.error('[API] Cancel turn error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
