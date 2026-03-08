import { NextRequest, NextResponse } from 'next/server';
import { getJobById, createResumedJob, updateJobStatus, canResumeJob } from '@/lib/db/jobs';
import { schedulerService } from '@/lib/scheduler';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');
    const additionalSteps = searchParams.get('additionalSteps');
    const guidance = searchParams.get('guidance');

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    const job = await getJobById(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Allow resume from completed or max_steps_reached
    const validStatuses = ['completed', 'max_steps_reached'];
    if (!validStatuses.includes(job.status)) {
      return NextResponse.json(
        { error: `Job is not in a resumable status (current: ${job.status})` },
        { status: 400 }
      );
    }

    // Check if job can be resumed (max resume limit)
    const { canResume, reason } = canResumeJob(job);
    if (!canResume) {
      return NextResponse.json({ error: reason }, { status: 400 });
    }

    const steps = additionalSteps ? parseInt(additionalSteps, 10) : undefined;
    const newJobId = await createResumedJob(job, steps, guidance ?? undefined);

    // Schedule the resumed job
    await schedulerService.scheduleOnce(newJobId, job.chatId, job.taskDescription, 0, { specialistId: newJobId });

    // Update original job status
    await updateJobStatus(jobId, 'completed', undefined, 'Resumed via dashboard');

    return NextResponse.json({
      success: true,
      jobId: newJobId,
      originalJobId: jobId,
      additionalSteps: steps ?? job.maxStepsUsed ?? 15,
      guidance: guidance ?? null,
    });
  } catch (error) {
    console.error('[API] Resume specialist error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
