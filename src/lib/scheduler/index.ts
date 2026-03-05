import { PgBoss, Job } from 'pg-boss';
import { CronExpressionParser } from 'cron-parser';

export type TaskRunFn = (data: TaskData) => Promise<void>;

export const TASK_QUEUE_PREFIX = 'task-';
export const ONE_OFF_QUEUE = 'once-off-tasks';
const SCHEDULER_REQUEST_QUEUE = 'scheduler-requests';

/** Data payload stored with every pg-boss schedule and propagated to each job. */
export interface TaskData {
  taskId: string;
  chatId: string;
  description: string;
  /** Set for background specialist jobs so the handler can emit orchestration events. */
  specialistId?: string;
  /** Persona to use when running this task. Defaults to the chat's active persona. */
  personaId?: string;
}

/** Shape returned by getSchedules() — adds computed nextRunAt for convenience. */
export interface ScheduleView {
  taskId: string;
  chatId: string;
  description: string;
  personaId?: string;
  cron: string;
  nextRunAt: string | null;
}

export interface OneOffTaskView {
  taskId: string;
  chatId: string;
  description: string;
  personaId?: string;
  runAt: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
}

interface ScheduleRequestJob {
  op: 'upsert';
  taskId: string;
  chatId: string;
  description: string;
  cronExpression: string;
  personaId?: string;
}

export function computeNextRun(expr: string): Date | undefined {
  try {
    return CronExpressionParser.parse(expr).next().toDate();
  } catch {
    return undefined;
  }
}

// ── pg-boss singleton (one per Node.js process) ───────────────────────────────
//
// Both the bot process and the Next.js process get their own pg-boss instance.
// The bot registers the worker; Next.js is producer-only.  pg-boss coordinates
// schedule monitoring across instances via DB-level SKIP LOCKED — only one
// instance creates each scheduled job per tick, and only the bot's worker
// processes jobs.

declare global {
  // eslint-disable-next-line no-var
  var __pgBoss: PgBoss | undefined;
}

async function getBoss(): Promise<PgBoss> {
  if (!globalThis.__pgBoss) {
    const boss = new PgBoss({
      connectionString:
        process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres',
      max: 3,
      // Ensure cron-based scheduling is enabled and monitored
      schedule: true,
      cronMonitorIntervalSeconds: 10,
      cronWorkerIntervalSeconds: 10,
      clockMonitorIntervalSeconds: 10,
    });
    boss.on('error', (err) => console.error('[pg-boss]', err));
    await boss.start();
    globalThis.__pgBoss = boss;
  }
  return globalThis.__pgBoss;
}

// ── SchedulerService ──────────────────────────────────────────────────────────

class SchedulerService {
  private taskRunFn: TaskRunFn | null = null;
  private readonly registeredQueues = new Set<string>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Called once by the bot process on startup. Registers the workers
   * that handle all scheduled tasks. Must NOT be called in Next.js.
   */
  async initialize(runFn: TaskRunFn): Promise<void> {
    this.taskRunFn = runFn;

    const boss = await getBoss();

    // Crate once-off queue (if it doesn't exist)
    await boss.createQueue(ONE_OFF_QUEUE)

    // Initial sync of all existing task:* schedules
    await this.syncWorkers();

    // Ensure one-off queue worker is registered
    await this.registerWorker(ONE_OFF_QUEUE, runFn);

    // Worker to apply schedule requests coming from the Next.js API
    await boss.createQueue(SCHEDULER_REQUEST_QUEUE);
    await boss.work(
      SCHEDULER_REQUEST_QUEUE,
      async ([job]: Job<ScheduleRequestJob>[]) => {
        if (!job) return;
        const { op, taskId, chatId, description, cronExpression, personaId } = job.data;
        if (op === 'upsert') {
          await this.upsertSchedule(taskId, chatId, description, cronExpression, personaId);
        }
      },
    );

    // Background sync to pick up new schedules created from other processes
    if (!this.syncTimer) {
      this.syncTimer = setInterval(() => {
        this.syncWorkers().catch((err) =>
          console.error('[Scheduler] Failed to sync workers from schedules:', err),
        );
      }, 30_000);
      // Allow process to exit naturally even if the timer is active
      this.syncTimer.unref?.();
    }

    console.log('[Scheduler] Initialized — workers registered and sync loop started.');
  }

  /**
   * Create or update (upsert) a scheduled task.
   * Safe to call from any process — writes to pgboss.schedule.
   */
  async scheduleTask(
    taskId: string,
    chatId: string,
    description: string,
    cronExpression: string,
    personaId?: string,
  ): Promise<void> {
    // In the bot process (where initialize() has been called), we apply the
    // schedule directly. In any other process (e.g. Next.js API), we enqueue a
    // schedule request for the bot to handle.
    if (!this.taskRunFn) {
      const boss = await getBoss();
      await boss.createQueue(SCHEDULER_REQUEST_QUEUE);
      await boss.send(SCHEDULER_REQUEST_QUEUE, {
        op: 'upsert',
        taskId,
        chatId,
        description,
        cronExpression,
        personaId,
      } satisfies ScheduleRequestJob);
      return;
    }

    await this.upsertSchedule(taskId, chatId, description, cronExpression, personaId);
  }

  private async upsertSchedule(
    taskId: string,
    chatId: string,
    description: string,
    cronExpression: string,
    personaId?: string,
  ): Promise<void> {
    const boss = await getBoss();

    const queueName = `${TASK_QUEUE_PREFIX}${taskId}`;

    await boss.createQueue(queueName);

    await boss.schedule(queueName, cronExpression, {
      taskId,
      chatId,
      description,
      ...(personaId ? { personaId } : {}),
    } satisfies TaskData);

    // Ensure a worker is attached in this process
    if (this.taskRunFn) {
      await this.registerWorker(queueName, this.taskRunFn);
    }
  }

  /**
   * Schedule a one-off task to run once after a delay.
   * The task is automatically deleted after execution.
   * @param delayMs Delay in milliseconds before the task runs
   */
  async scheduleOnce(
    taskId: string,
    chatId: string,
    description: string,
    delayMs: number,
    extra?: Partial<Pick<TaskData, 'specialistId' | 'personaId'>>,
  ): Promise<string | null> {
    const boss = await getBoss();
    await boss.createQueue(ONE_OFF_QUEUE);

    const delayInSeconds = Math.ceil(delayMs / 1000);
    const payload: TaskData = { taskId, chatId, description, ...extra };
    return boss.send(ONE_OFF_QUEUE, payload, { startAfter: delayInSeconds });
  }

  async unschedule(taskId: string): Promise<void> {
    const boss = await getBoss();
    const sched = taskId.startsWith(TASK_QUEUE_PREFIX) ? taskId : `${TASK_QUEUE_PREFIX}${taskId}`;
    await boss.unschedule(sched);
    this.unscheduleTask(taskId);
  }

  /**
   * Remove a scheduled task permanently.
   * Safe to call from any process — deletes from pgboss.schedule.
   */
  async unscheduleTask(taskId: string): Promise<void> {
    
    const boss = await getBoss();

    const schedules = await boss.getSchedules();
    
    for (const schedule of schedules) {
      if (!schedule.name.startsWith(TASK_QUEUE_PREFIX)) continue;
      const data = (schedule.data ?? {}) as TaskData;
      if (data.taskId === taskId) {
        await boss.unschedule(schedule.name, schedule.cron);
      }
    }
  }

  /**
   * List all active scheduled tasks for the given chatId (or all if omitted).
   * Reads directly from pgboss.schedule.
   */
  async getSchedules(chatId?: string): Promise<ScheduleView[]> {
    const boss = await getBoss();
    const all = await boss.getSchedules();
    return all
      .filter((s) => s.name.startsWith(TASK_QUEUE_PREFIX))
      .map((s) => {
        const data = (s.data ?? {}) as TaskData;
        return {
          scheduleName: s.name,
          taskId: data.taskId ?? '',
          chatId: data.chatId ?? '',
          description: data.description ?? '',
          personaId: data.personaId,
          cron: s.cron,
          nextRunAt: computeNextRun(s.cron)?.toISOString() ?? null,
        };
      })
      .filter((s) => !chatId || s.chatId === chatId);
  }

  async getOneOffTasks(chatId?: string): Promise<OneOffTaskView[]> {
    const boss = await getBoss();
    const jobs = await boss.findJobs<TaskData>(ONE_OFF_QUEUE);

    return jobs
      .filter((job) => job.state === 'created' || job.state === 'retry' || job.state === 'active')
      .map((job) => {
        const data = (job.data ?? {}) as TaskData;
        return {
          taskId: data.taskId ?? job.id,
          chatId: data.chatId ?? '',
          description: data.description ?? '',
          personaId: data.personaId,
          runAt: job.startAfter.toISOString(),
          state: job.state,
        };
      })
      .filter((t) => !chatId || t.chatId === chatId);
  }

  private async registerWorker(queueName: string, runFn: TaskRunFn): Promise<void> {
    if (this.registeredQueues.has(queueName)) return;

    const boss = await getBoss();
    this.registeredQueues.add(queueName);

    await boss.work(
      queueName,
      async (jobOrJobs: Job<TaskData> | Job<TaskData>[]) => {
        const job = Array.isArray(jobOrJobs) ? jobOrJobs[0] : jobOrJobs;
        if (!job) return;
        const data = job.data;
        console.log(
          `[Scheduler] Processing job from queue "${queueName}" for chat ${data.chatId}, task ${data.taskId}`,
        );
        await runFn(data);
      },
    );

    console.log(`[Scheduler] Worker registered for queue "${queueName}".`);
  }

  private async syncWorkers(): Promise<void> {
    if (!this.taskRunFn) return;
    const boss = await getBoss();
    const schedules = await boss.getSchedules();
    const taskSchedules = schedules.filter((s) => s.name.startsWith(TASK_QUEUE_PREFIX));

    for (const schedule of taskSchedules) {
      await this.registerWorker(schedule.name, this.taskRunFn);
    }

    if (taskSchedules.length > 0) {
      console.log(
        `[Scheduler] Synced ${taskSchedules.length} task queues from schedules table.`,
      );
    }
  }
}

export const schedulerService = new SchedulerService();
