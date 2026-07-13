import { db, pgClient } from './index';
import { jobs } from './schema';
import { eq, inArray, and } from 'drizzle-orm';
import type { Job, NewJob } from './schema';
import { configManager } from '../config';

/** Postgres NOTIFY channel used by scheduler.waitForJobs() for event-driven
 *  specialist-completion waits instead of polling the jobs table. */
export const JOB_STATUS_CHANNEL = 'opentalon_job_status';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'max_steps_reached']);

export function getMaxResumeCount(): number {
  return configManager.get().llm?.maxResume ?? 5;
}

export function canResumeJob(job: Job): { canResume: boolean; reason?: string } {
  const maxResume = getMaxResumeCount();
  const currentCount = job.resumeCount ?? 0;

  if (currentCount >= maxResume) {
    return { canResume: false, reason: `Maximum resume limit (${maxResume}) reached` };
  }
  return { canResume: true };
}

export async function createJob(
  data: Omit<NewJob, 'id' | 'createdAt' | 'updatedAt'>,
  id?: string
): Promise<string> {
  const jobId = id ?? crypto.randomUUID();
  await db.insert(jobs).values({ id: jobId, ...data });
  return jobId;
}

export async function updateJobStatus(
  id: string,
  status: Job['status'],
  result?: string,
  errorMessage?: string,
  maxStepsUsed?: number
): Promise<void> {
  await db
    .update(jobs)
    .set({ status, result, errorMessage, maxStepsUsed, updatedAt: new Date() })
    .where(eq(jobs.id, id));

  if (TERMINAL_STATUSES.has(status)) {
    // Best-effort: notify listeners (scheduler.waitForJobs) that this job
    // reached a terminal state. Failure here must never break the status
    // update itself — waitForJobs also falls back to periodic polling.
    pgClient.notify(JOB_STATUS_CHANNEL, id).catch((err) => {
      console.error('[Jobs] Failed to notify job status change:', err);
    });
  }
}

export async function getJobById(id: string): Promise<Job | undefined> {
  const result = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return result[0];
}

export async function getJobsByChatId(chatId: string, limit = 10): Promise<Job[]> {
  return db.select().from(jobs).where(eq(jobs.chatId, chatId)).limit(limit);
}

export async function getRunningJobs(): Promise<Job[]> {
  return db.select().from(jobs).where(inArray(jobs.status, ['pending', 'running']));
}

export async function getRunningJobsForChat(chatId: string): Promise<Job[]> {
  return db.select().from(jobs)
    .where(and(eq(jobs.chatId, chatId), inArray(jobs.status, ['pending', 'running'])));
}

export async function getMaxStepsJobs(): Promise<Job[]> {
  return db.select().from(jobs).where(eq(jobs.status, 'max_steps_reached'));
}

export async function cancelRunningJobs(): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'failed', errorMessage: 'Service restart', updatedAt: new Date() })
    .where(inArray(jobs.status, ['pending', 'running']));
}

export async function createResumedJob(
  originalJob: Job,
  additionalSteps?: number,
  userGuidance?: string
): Promise<string> {
  const id = crypto.randomUUID();
  // Default additional steps to same as original maxStepsUsed (or 15 if unknown)
  const steps = additionalSteps ?? originalJob.maxStepsUsed ?? 15;

  // Build task description with original result as context
  let taskDescription = '[RESUMED]\n';
  taskDescription += `Original task: ${originalJob.taskDescription}\n\n`;

  if (originalJob.result) {
    taskDescription += `Original result:\n${originalJob.result}\n\n`;
  }

  if (userGuidance) {
    taskDescription += `[User guidance]: ${userGuidance}`;
  }

  await db.insert(jobs).values({
    id,
    chatId: originalJob.chatId,
    status: 'pending',
    taskDescription,
    result: originalJob.result,
    resumeOf: originalJob.id,
    maxStepsUsed: steps,
    userGuidance: userGuidance ?? null,
    resumeCount: (originalJob.resumeCount ?? 0) + 1,
  });
  return id;
}
