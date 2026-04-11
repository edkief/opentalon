import { NextRequest, NextResponse } from 'next/server';
import { cancellationRegistry } from '@/lib/agent/cancellation';
import { updateJobStatus } from '@/lib/db/jobs';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    const cancelled = cancellationRegistry.cancel(jobId);

    if (cancelled) {
      await updateJobStatus(jobId, 'failed', undefined, 'Cancelled via dashboard');
      return NextResponse.json({ success: true, jobId });
    }

    // Not in the in-process registry — specialist may have already finished or
    // is running in a separate process (pg-boss worker). Mark the job failed so
    // the dashboard reflects the intent even if the abort signal can't propagate.
    await updateJobStatus(jobId, 'failed', undefined, 'Cancelled via dashboard (process boundary)');
    return NextResponse.json({ success: true, jobId, note: 'Job not found in active registry; status updated in DB' });
  } catch (error) {
    console.error('[API] Cancel specialist error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
