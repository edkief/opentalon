import { NextRequest, NextResponse } from 'next/server';
import { getJobById, createResumedJob, updateJobStatus } from '@/lib/db/jobs';
import { schedulerService } from '@/lib/scheduler';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');
    const additionalSteps = searchParams.get('additionalSteps');

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    const job = await getJobById(jobId);
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'max_steps_reached') {
      return NextResponse.json(
        { error: `Job is not in max_steps_reached status (current: ${job.status})` },
        { status: 400 }
      );
    }

    const steps = additionalSteps ? parseInt(additionalSteps, 10) : undefined;
    const newJobId = await createResumedJob(job, steps);

    // Schedule the resumed job
    await schedulerService.scheduleOnce(newJobId, job.chatId, job.taskDescription, 0, { specialistId: newJobId });

    // Update original job status
    await updateJobStatus(jobId, 'completed', undefined, 'Resumed via dashboard');

    return NextResponse.json({
      success: true,
      jobId: newJobId,
      originalJobId: jobId,
      additionalSteps: steps ?? job.maxStepsUsed ?? 15,
    });
  } catch (error) {
    console.error('[API] Resume specialist error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
