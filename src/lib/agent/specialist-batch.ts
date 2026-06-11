import { db } from '../db';
import { jobs, specialistBatches } from '../db/schema';
import type { Job, SpecialistBatch } from '../db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { addMessage } from '../db/conversation';
import { ingestMemory } from '../memory';
import { schedulerService } from '../scheduler';
import { sendToChat } from '../telegram/handlers';

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
  const mode = jobIds.length >= 2 ? 'synthesis' : 'direct';

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

  if (batch.mode === 'direct') {
    await deliverDirect(batch, members[0]);
  } else {
    await dispatchSynthesisTurn(batch, members);
  }
}

async function deliverDirect(batch: SpecialistBatch, job: Job): Promise<void> {
  const taskLabel = job.taskDescription.split('\n')[0]?.slice(0, 80) ?? 'Task';
  const result = job.result ?? job.errorMessage ?? '(no output)';
  const message = `↩️ Re: "${taskLabel}"\n\n${result}`;

  await sendToChat(batch.chatId, message);
  addMessage(batch.chatId, 0, 'user', job.taskDescription, batch.agentId ?? 'default').catch(console.error);
  addMessage(batch.chatId, 0, 'assistant', result, batch.agentId ?? 'default').catch(console.error);
  const agentId = batch.agentId ?? undefined;
  ingestMemory({ chatId: batch.chatId, scope: 'private', author: 'user', text: job.taskDescription, agent: agentId }).catch(console.error);
  ingestMemory({ chatId: batch.chatId, scope: 'private', author: 'exchange', text: `User: ${job.taskDescription}\nAssistant: ${result}`, agent: agentId }).catch(console.error);
}

async function dispatchSynthesisTurn(batch: SpecialistBatch, members: Job[]): Promise<void> {
  const sections = members
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .map((j) => {
      const label = j.taskDescription.split('\n')[0]?.slice(0, 80) ?? 'Task';
      const result = j.result ?? j.errorMessage ?? '(no output)';
      const truncated = result.length > 3000 ? result.slice(0, 3000) + '...' : result;
      return `[${label}]\n${truncated}`;
    })
    .join('\n\n');

  const originalRequest = batch.originalRequest ?? '(original request unavailable)';
  const prompt =
    `The user asked: "${originalRequest}"\n\n` +
    `You delegated this to ${members.length} specialists. Their results:\n\n${sections}\n\n` +
    `Synthesize these into a single cohesive response to the user. Do not mention the delegation mechanics.`;

  const synthesisId = crypto.randomUUID();
  await schedulerService.scheduleOnce(synthesisId, batch.chatId, prompt, 0, {
    agentId: batch.agentId ?? undefined,
    synthesis: true,
  });
}
