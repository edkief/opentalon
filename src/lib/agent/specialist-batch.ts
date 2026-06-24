import { db } from '../db';
import { jobs, specialistBatches } from '../db/schema';
import type { Job, SpecialistBatch } from '../db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { schedulerService } from '../scheduler';

const TERMINAL_STATUSES = ['completed', 'failed', 'timed_out', 'max_steps_reached'] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

function isTerminal(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Register a batch of background specialist jobs spawned in a single parent turn.
 * Stamps each job row with the batchId, then immediately tries to dispatch
 * (handles the case where all specialists somehow finished before this ran).
 */
export async function registerSpecialistBatch(options: {
  chatId: string;
  agentId?: string;
  jobIds: string[];
  originalRequest: string;
}): Promise<void> {
  const { chatId, agentId, jobIds, originalRequest } = options;
  if (jobIds.length === 0) return;

  const batchId = crypto.randomUUID();
  // Always route results back through a supervisor review turn so the agent can
  // review against broader context and act on them. ('direct' is now vestigial.)
  const mode = 'synthesis';

  await db.insert(specialistBatches).values({
    id: batchId,
    chatId,
    agentId,
    expectedCount: jobIds.length,
    mode,
    status: 'pending',
    originalRequest,
  });

  await db
    .update(jobs)
    .set({ batchId, updatedAt: new Date() })
    .where(inArray(jobs.id, jobIds));

  await maybeDispatchBatch(batchId);
}

/**
 * Called when a specialist job completes. Re-reads the job to get its batchId,
 * then tries to dispatch the batch if all members are terminal.
 * Safe to call multiple times (CAS guard prevents double delivery).
 */
export async function notifyBatchMemberComplete(jobId: string): Promise<void> {
  const [job] = await db.select({ batchId: jobs.batchId }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job?.batchId) return;
  await maybeDispatchBatch(job.batchId);
}

async function maybeDispatchBatch(batchId: string): Promise<void> {
  const [batch] = await db.select().from(specialistBatches).where(eq(specialistBatches.id, batchId)).limit(1);
  if (!batch || batch.status !== 'pending') return;

  const members = await db.select().from(jobs).where(eq(jobs.batchId, batchId));

  const allTerminal = members.length >= batch.expectedCount && members.every((j) => isTerminal(j.status));
  if (!allTerminal) return;

  // CAS: only the caller that successfully flips status wins delivery.
  const won = await db
    .update(specialistBatches)
    .set({ status: 'dispatched' })
    .where(sql`${specialistBatches.id} = ${batchId} AND ${specialistBatches.status} = 'pending'`)
    .returning({ id: specialistBatches.id });

  if (won.length === 0) return;

  await dispatchSynthesisTurn(batch, members);
}

async function dispatchSynthesisTurn(batch: SpecialistBatch, members: Job[]): Promise<void> {
  const single = members.length === 1;
  // One specialist: pass the full stored result (already capped at 5000 in the
  // jobs row) to preserve detail. Many: bound each result to keep the prompt small.
  const perResultBudget = single ? Infinity : 3000;
  const sections = members
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .map((j) => {
      const label = j.taskDescription.split('\n')[0]?.slice(0, 80) ?? 'Task';
      const result = j.result ?? j.errorMessage ?? '(no output)';
      const truncated = result.length > perResultBudget ? result.slice(0, perResultBudget) + '...' : result;
      const statusNote = j.status !== 'completed' ? ` [${j.status}]` : '';
      return `[${label}]${statusNote} (job: \`${j.id}\`)\n${truncated}`;
    })
    .join('\n\n');

  const originalRequest = batch.originalRequest ?? '(original request unavailable)';
  const prompt =
    `The user asked: "${originalRequest}"\n\n` +
    `You previously delegated this work to ${single ? 'a background specialist' : `${members.length} background specialists`}. ` +
    `${single ? 'It has' : 'They have'} now completed:\n\n${sections}\n\n` +
    `Review ${single ? 'this result' : 'these results'} in context of the conversation and the user's original request. ` +
    `Take any appropriate follow-up action (such as formatting output, saving findings to memory, or asking a clarifying question), then reply to the user. ` +
    `Preserve important detail rather than over-summarizing — condense only where it genuinely helps. ` +
    `Do not mention the delegation mechanics or job IDs in your reply.`;

  const synthesisId = crypto.randomUUID();
  await schedulerService.scheduleOnce(synthesisId, batch.chatId, prompt, 0, {
    agentId: batch.agentId ?? undefined,
    synthesis: true,
  });
}
