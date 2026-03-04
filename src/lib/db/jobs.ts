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
  errorMessage?: string
): Promise<void> {
  await db
    .update(jobs)
    .set({ status, result, errorMessage, updatedAt: new Date() })
    .where(eq(jobs.id, id));
}

export async function getJobsByChatId(chatId: string, limit = 10): Promise<Job[]> {
  return db.select().from(jobs).where(eq(jobs.chatId, chatId)).limit(limit);
}

export async function getRunningJobs(): Promise<Job[]> {
  return db.select().from(jobs).where(inArray(jobs.status, ['pending', 'running']));
}

export async function cancelRunningJobs(): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'failed', errorMessage: 'Service restart', updatedAt: new Date() })
    .where(inArray(jobs.status, ['pending', 'running']));
}
