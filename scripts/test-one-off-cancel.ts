/**
 * Checks for cancelling one-off scheduled tasks (#64), plus the recurring
 * delete path that shares the same dashboard page and agent tool.
 *
 * Before this, nothing could remove a queued one-off: `delete_scheduled_task`
 * only touched pg-boss cron schedules, found nothing for a one-off id, and
 * reported success anyway — so the task still fired.
 *
 * Needs a real Postgres (pg-boss creates its own schema). No worker is
 * registered here; a job is made `active` by fetching it directly, which is
 * exactly what the bot's worker does.
 *
 * Run with: pnpm test:one-off-cancel
 */
import { NextRequest } from 'next/server';
import type { PgBoss } from 'pg-boss';
import { schedulerService, ONE_OFF_QUEUE, TASK_QUEUE_PREFIX } from '../src/lib/scheduler';
import { getSchedulingTools } from '../src/lib/tools/scheduling';
import { pgClient } from '../src/lib/db';
import { DELETE as deleteOnce } from '../src/app/api/scheduled-tasks/once/route';
import { DELETE as deleteRecurring } from '../src/app/api/scheduled-tasks/[id]/route';

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
const OTHER_CHAT = `${CHAT}-other`;
const HOUR = 60 * 60 * 1000;

const tools = getSchedulingTools(CHAT);
// The AI SDK types execute() loosely; this keeps the calls readable.
type Exec = (input: unknown, opts: unknown) => Promise<string>;
const call = (name: string, input: unknown) => (tools[name].execute as unknown as Exec)(input, {});

const listed = async (taskId: string) =>
  (await schedulerService.getOneOffTasks(CHAT)).find((t) => t.taskId === taskId);

async function jobState(boss: PgBoss, taskId: string): Promise<string | undefined> {
  const jobs = await boss.findJobs<{ taskId: string }>(ONE_OFF_QUEUE);
  return jobs.find((j) => j.data.taskId === taskId)?.state;
}

/** Create a cron schedule directly — scheduleTask() only enqueues a request outside the bot process. */
async function addCron(boss: PgBoss, taskId: string, chatId = CHAT): Promise<void> {
  const name = `${TASK_QUEUE_PREFIX}${taskId}`;
  await boss.createQueue(name);
  await boss.schedule(name, '0 9 * * *', { taskId, chatId, description: 'daily check' });
}

const hasCron = async (taskId: string) =>
  (await schedulerService.getSchedules()).some((s) => s.taskId === taskId);

async function main(): Promise<void> {
  // Any scheduler call boots the pg-boss singleton.
  await schedulerService.getOneOffTasks(CHAT);
  const boss = globalThis.__pgBoss!;
  // Drain anything already due so fetch() below only ever sees this run's jobs.
  await boss.deleteQueuedJobs(ONE_OFF_QUEUE);

  console.log('\n[1] a queued one-off is cancelled before its run time');
  const future = crypto.randomUUID();
  await schedulerService.scheduleOnce(future, CHAT, 'remind me later', HOUR);
  ok('it is listed as cancellable', (await listed(future))?.cancellable === true);
  ok('cancel reports cancelled', (await schedulerService.cancelOneOffTask(future)).state === 'cancelled');
  ok('the job is cancelled in pg-boss', (await jobState(boss, future)) === 'cancelled');
  ok('it is gone from the one-off list', (await listed(future)) === undefined);
  ok('cancelling again is still cancelled (idempotent)',
    (await schedulerService.cancelOneOffTask(future)).state === 'cancelled');

  console.log('\n[2] a due-but-unclaimed one-off is cancelled and never handed to a worker');
  const due = crypto.randomUUID();
  await schedulerService.scheduleOnce(due, CHAT, 'due now', 0);
  ok('cancel reports cancelled', (await schedulerService.cancelOneOffTask(due)).state === 'cancelled');
  ok('a worker fetch gets nothing', (await boss.fetch(ONE_OFF_QUEUE)).length === 0);

  console.log('\n[3] a one-off the worker already picked up is left alone');
  const running = crypto.randomUUID();
  await schedulerService.scheduleOnce(running, CHAT, 'already going', 0);
  const [claimed] = await boss.fetch(ONE_OFF_QUEUE);
  ok('the worker claimed it', (await jobState(boss, running)) === 'active');
  ok('it is listed but not cancellable', (await listed(running))?.cancellable === false);
  ok('cancel reports already_running',
    (await schedulerService.cancelOneOffTask(running)).state === 'already_running');
  ok('the job is still active', (await jobState(boss, running)) === 'active');
  await boss.complete(ONE_OFF_QUEUE, claimed.id);
  ok('once it has run, cancel reports already_finished',
    (await schedulerService.cancelOneOffTask(running)).state === 'already_finished');

  console.log('\n[4] ids that are not a cancellable one-off');
  ok('unknown id is not_found',
    (await schedulerService.cancelOneOffTask(crypto.randomUUID())).state === 'not_found');
  const specialist = crypto.randomUUID();
  await schedulerService.scheduleOnce(specialist, CHAT, 'background specialist', HOUR, { specialistId: specialist });
  ok('a queued specialist job is not_cancellable',
    (await schedulerService.cancelOneOffTask(specialist)).state === 'not_cancellable');
  ok('and is left queued', (await jobState(boss, specialist)) === 'created');
  ok('and is listed as not cancellable', (await listed(specialist))?.cancellable === false);
  const scoped = crypto.randomUUID();
  await schedulerService.scheduleOnce(scoped, CHAT, 'belongs to CHAT', HOUR);
  ok('another chat cannot cancel it',
    (await schedulerService.cancelOneOffTask(scoped, OTHER_CHAT)).state === 'not_found');
  ok('and it is left queued', (await jobState(boss, scoped)) === 'created');

  console.log('\n[5] DELETE /api/scheduled-tasks/once');
  const del = (qs: string) =>
    deleteOnce(new NextRequest(`http://localhost/api/scheduled-tasks/once${qs}`, { method: 'DELETE' }));
  ok('missing taskId is 400', (await del('')).status === 400);
  ok('unknown taskId is 404', (await del(`?taskId=${crypto.randomUUID()}`)).status === 404);
  ok('specialist job is 409', (await del(`?taskId=${specialist}`)).status === 409);
  const viaApi = await del(`?taskId=${scoped}`);
  ok('queued task is 200 cancelled',
    viaApi.status === 200 && (await viaApi.json()).state === 'cancelled');
  ok('the job is cancelled in pg-boss', (await jobState(boss, scoped)) === 'cancelled');

  console.log('\n[6] delete_scheduled_task covers one-off tasks');
  const scheduled = JSON.parse(await call('schedule_once', { description: 'tool reminder', delay_minutes: 60 }));
  ok('list_scheduled_tasks shows the one-off with its id',
    (await call('list_scheduled_tasks', {})).includes(scheduled.taskId));
  const deleted = await call('delete_scheduled_task', { task_id: scheduled.taskId });
  ok('it reports the cancellation', deleted.includes('cancelled') && !deleted.includes('error'));
  ok('the job is cancelled in pg-boss', (await jobState(boss, scheduled.taskId)) === 'cancelled');
  ok('list_scheduled_tasks no longer shows it',
    !(await call('list_scheduled_tasks', {})).includes(scheduled.taskId));
  const missing = await call('delete_scheduled_task', { task_id: crypto.randomUUID() });
  ok('an unknown id is an error, not a false "deleted"', missing.includes('error') && missing.includes('not found'));

  console.log('\n[7] recurring tasks still delete — by taskId');
  const cronViaTool = crypto.randomUUID();
  await addCron(boss, cronViaTool);
  ok('the cron task exists', await hasCron(cronViaTool));
  ok('delete_scheduled_task reports deleted',
    (await call('delete_scheduled_task', { task_id: cronViaTool })).includes('deleted'));
  ok('the cron task is gone', !(await hasCron(cronViaTool)));

  const delCron = (id: string) =>
    deleteRecurring(new NextRequest(`http://localhost/api/scheduled-tasks/${id}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id }),
    });
  const cronViaApi = crypto.randomUUID();
  await addCron(boss, cronViaApi);
  // The dashboard used to send the literal string "undefined" here and get ok back.
  ok('DELETE /undefined is 404', (await delCron('undefined')).status === 404);
  ok('and removes nothing', await hasCron(cronViaApi));
  ok('DELETE by taskId is 200', (await delCron(cronViaApi)).status === 200);
  ok('the cron task is gone', !(await hasCron(cronViaApi)));

  const disabledCron = crypto.randomUUID();
  await addCron(boss, disabledCron);
  await schedulerService.disableTask(disabledCron);
  ok('disabling removes the cron schedule, so it stops firing',
    !(await boss.getSchedules()).some((s) => s.name === `${TASK_QUEUE_PREFIX}${disabledCron}`));
  ok('a disabled task is still listed',
    (await schedulerService.getSchedules()).some((s) => s.taskId === disabledCron && !s.enabled));
  ok('DELETE on a disabled task is 200', (await delCron(disabledCron)).status === 200);
  ok('the disabled task is gone', !(await hasCron(disabledCron)));

  // Leave nothing queued behind (the specialist job from [4] is still `created`).
  await boss.deleteQueuedJobs(ONE_OFF_QUEUE);
  await boss.deleteQueue(`${TASK_QUEUE_PREFIX}${cronViaTool}`);
  await boss.deleteQueue(`${TASK_QUEUE_PREFIX}${cronViaApi}`);
  await boss.deleteQueue(`${TASK_QUEUE_PREFIX}${disabledCron}`);
  await boss.stop({ graceful: false });
  await pgClient.end();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
