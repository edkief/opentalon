/**
 * Checks for the startup sweep of jobs interrupted by a restart.
 *
 * A job runs in-process, so a restart kills everything that was running. Its
 * row used to stay `running` forever: the dashboard kept showing it, the
 * non-forced restart API refused to restart over it, and every supervisor
 * prompt listed it under "Background Specialists In Progress".
 *
 * Needs a real Postgres. Like a real startup, the sweep covers every in-flight
 * row in the target database, not just the ones this script creates.
 *
 * Run with: pnpm test:restart-jobs
 */
import { inArray } from 'drizzle-orm';
import { db, pgClient } from '../src/lib/db';
import { jobs, specialistRuns } from '../src/lib/db/schema';
import { createJob, getJobById, failInterruptedJobs, INTERRUPTED_BY_RESTART } from '../src/lib/db/jobs';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

const CHAT = `test-chat-${crypto.randomUUID()}`;
const id = () => crypto.randomUUID();

async function addRun(specialistId: string): Promise<void> {
  await db.insert(specialistRuns).values({
    specialistId,
    parentSessionId: CHAT,
    taskDescription: 'task',
    status: 'running',
    spawnedAt: new Date(),
  });
}

async function runStatus(specialistId: string): Promise<string | undefined> {
  const [row] = await db.select().from(specialistRuns).where(inArray(specialistRuns.specialistId, [specialistId]));
  return row?.status;
}

async function main(): Promise<void> {
  const running = id();
  const queued = id();
  const handedOver = id();
  const done = id();
  const cronRun = id();
  const all = [running, queued, handedOver, done, cronRun];

  try {
    await createJob({ chatId: CHAT, status: 'running', taskDescription: 'was running' }, running);
    await createJob({ chatId: CHAT, status: 'pending', taskDescription: 'still queued in pg-boss' }, queued);
    await createJob({ chatId: CHAT, status: 'pending', taskDescription: 'taken off the queue' }, handedOver);
    await createJob({ chatId: CHAT, status: 'completed', taskDescription: 'finished', result: 'ok' }, done);
    for (const s of [running, queued, handedOver, cronRun]) await addRun(s);

    console.log('\n[1] Jobs');
    const dead = await failInterruptedJobs(new Set([queued]));
    const deadIds = new Set(dead.map((j) => j.id));

    const r = await getJobById(running);
    ok('a running job is marked failed', r?.status === 'failed');
    ok('its error says it was interrupted by a restart', r?.errorMessage === INTERRUPTED_BY_RESTART);
    ok('a pending job no longer queued is marked failed', (await getJobById(handedOver))?.status === 'failed');
    ok('a pending job still queued is left pending', (await getJobById(queued))?.status === 'pending');
    ok('a finished job is untouched', (await getJobById(done))?.status === 'completed');
    ok('the failed jobs are returned', deadIds.has(running) && deadIds.has(handedOver));
    ok('the queued and finished jobs are not', !deadIds.has(queued) && !deadIds.has(done));

    console.log('\n[2] Orchestration rows');
    ok('a running job\'s run is marked error', (await runStatus(running)) === 'error');
    ok('a handed-over job\'s run is marked error', (await runStatus(handedOver)) === 'error');
    ok('a run with no job row (cron) is marked error', (await runStatus(cronRun)) === 'error');
    ok('a still-queued job\'s run stays running', (await runStatus(queued)) === 'running');

    console.log('\n[3] Idempotent');
    const again = await failInterruptedJobs(new Set([queued]));
    ok('a second sweep finds none of these jobs', !again.some((j) => all.includes(j.id)));
  } finally {
    await db.delete(jobs).where(inArray(jobs.id, all));
    await db.delete(specialistRuns).where(inArray(specialistRuns.specialistId, all));
  }
}

main()
  .then(async () => {
    await pgClient.end();
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed\n');
  })
  .catch(async (err) => {
    console.error(err);
    await pgClient.end().catch(() => {});
    process.exit(1);
  });
