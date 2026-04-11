import { NextRequest, NextResponse } from 'next/server';
import { schedulerService } from '@/lib/scheduler';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    // If the specialist is running in this process the abort signal fires immediately.
    // Otherwise the request is forwarded to the bot process via pg-boss so the
    // in-process cancellation registry can be reached there.
    await schedulerService.cancelSpecialist(jobId);

    return NextResponse.json({ success: true, jobId });
  } catch (error) {
    console.error('[API] Cancel specialist error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
