import { db } from './index';
import { jobs } from './schema';
import { eq, inArray } from 'drizzle-orm';
import type { Job, NewJob } from './schema';

export async function createJob(
  data: Omit<NewJob, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(jobs).values({ id, ...data });
  return id;
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
  additionalSteps?: number
): Promise<string> {
  const id = crypto.randomUUID();
  // Default additional steps to same as original maxStepsUsed (or 15 if unknown)
  const steps = additionalSteps ?? originalJob.maxStepsUsed ?? 15;
  await db.insert(jobs).values({
    id,
    chatId: originalJob.chatId,
    status: 'pending',
    taskDescription: `[RESUMED] ${originalJob.taskDescription}`,
    result: originalJob.result,
    resumeOf: originalJob.id,
    maxStepsUsed: steps,
  });
  return id;
}
