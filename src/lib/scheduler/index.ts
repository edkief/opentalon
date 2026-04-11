import { PgBoss, Job } from 'pg-boss';
import { CronExpressionParser } from 'cron-parser';
import { configManager } from '../config';

export type TaskRunFn = (data: TaskData) => Promise<void>;

// Workflow queues (imported lazily to avoid circular deps)
export const WORKFLOW_NODE_QUEUE = 'workflow-node-execution';
export const WORKFLOW_RESUME_QUEUE = 'workflow-resume';

export const TASK_QUEUE_PREFIX = 'task-';
export const ONE_OFF_QUEUE = 'once-off-tasks';
const SCHEDULER_REQUEST_QUEUE = 'scheduler-requests';
const DISABLED_TASKS_QUEUE = 'scheduler-disabled';

/** Data payload stored with every pg-boss schedule and propagated to each job. */
export interface TaskData {
  taskId: string;
  chatId: string;
  description: string;
  /** Set for background specialist jobs so the handler can emit orchestration events. */
  specialistId?: string;
  /** Persona to use when running this task. Defaults to the chat's active agent. */
  agentId?: string;
  /** ID of the agent that called spawn_specialist — used to check sub-agent spawn permissions. */
  spawningAgentId?: string;
  /** ID of the specialist that spawned this one (depth=2 background sub-agents). */
  parentSpecialistId?: string;
  /** Whether this task is currently enabled (true) or disabled (false). */
  enabled?: boolean;
}

/** Shape returned by getSchedules() — adds computed nextRunAt for convenience. */
export interface ScheduleView {
  taskId: string;
  chatId: string;
  description: string;
  agentId?: string;
  cron: string;
  nextRunAt: string | null;
  enabled: boolean;
}

export interface OneOffTaskView {
  taskId: string;
  chatId: string;
  description: string;
  agentId?: string;
  runAt: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
}

interface ScheduleRequestJob {
  op: 'upsert' | 'disable' | 'enable' | 'execute' | 'cancel';
  taskId: string;
  chatId?: string;
  description?: string;
  cronExpression?: string;
  agentId?: string;
  /** For op='cancel': the specialistId (= pg-boss job id) to abort. */
  specialistId?: string;
}

export function computeNextRun(expr: string, tz?: string): Date | undefined {
  try {
    return CronExpressionParser.parse(expr, { tz: tz ?? 'UTC' }).next().toDate();
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

// ── Persistent disabled-task store (pg-boss queue used as a key-value store) ──
// Disabled tasks are stored as 'created' jobs in DISABLED_TASKS_QUEUE.
// This persists across process restarts and is visible to all processes.

interface DisabledTaskData extends TaskData {
  cron: string;
}

async function getDisabledTaskJobs(): Promise<Job<DisabledTaskData>[]> {
  const boss = await getBoss();
  await boss.createQueue(DISABLED_TASKS_QUEUE);
  const jobs = await boss.findJobs<DisabledTaskData>(DISABLED_TASKS_QUEUE);
  return jobs.filter((j) => j.state === 'created') as Job<DisabledTaskData>[];
}

async function isTaskDisabled(taskId: string): Promise<boolean> {
  const jobs = await getDisabledTaskJobs();
  return jobs.some((j) => j.data.taskId === taskId);
}

async function persistDisabledTask(data: DisabledTaskData): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(DISABLED_TASKS_QUEUE);
  // Use singletonKey to prevent duplicate entries for the same taskId
  await boss.send(DISABLED_TASKS_QUEUE, data, { singletonKey: data.taskId });
}

async function clearDisabledTask(taskId: string): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(DISABLED_TASKS_QUEUE);
  const jobs = await boss.findJobs<DisabledTaskData>(DISABLED_TASKS_QUEUE);
  for (const job of jobs) {
    if (job.data.taskId === taskId && job.state === 'created') {
      await boss.cancel(DISABLED_TASKS_QUEUE, job.id);
    }
  }
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

    // Register workflow orchestration queues
    await this.initWorkflowQueues();

    // Worker to apply schedule requests coming from the Next.js API
    await boss.createQueue(SCHEDULER_REQUEST_QUEUE);
    await boss.work(
      SCHEDULER_REQUEST_QUEUE,
      async ([job]: Job<ScheduleRequestJob>[]) => {
        if (!job) return;
        const { op, taskId, chatId, description, cronExpression, agentId } = job.data;
        if (op === 'upsert') {
          await this.upsertSchedule(taskId, chatId!, description!, cronExpression!, agentId);
        } else if (op === 'disable') {
          await this.disableSchedule(taskId);
        } else if (op === 'enable') {
          await this.enableSchedule(taskId);
        } else if (op === 'execute') {
          await this.executeNow(taskId);
        } else if (op === 'cancel') {
          const { cancellationRegistry } = await import('../agent/cancellation');
          const { updateJobStatus } = await import('../db/jobs');
          const sid = job.data.specialistId;
          if (sid) {
            cancellationRegistry.cancel(sid);
            await updateJobStatus(sid, 'failed', undefined, 'Cancelled via dashboard');
          }
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
    agentId?: string,
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
        agentId,
      } satisfies ScheduleRequestJob);
      return;
    }

    await this.upsertSchedule(taskId, chatId, description, cronExpression, agentId);
  }

  private async upsertSchedule(
    taskId: string,
    chatId: string,
    description: string,
    cronExpression: string,
    agentId?: string,
  ): Promise<void> {
    const boss = await getBoss();
    const timezone = configManager.get().timezone ?? 'UTC';

    const queueName = `${TASK_QUEUE_PREFIX}${taskId}`;

    // Check if task is disabled - don't schedule if disabled
    const disabled = await isTaskDisabled(taskId);

    await boss.createQueue(queueName);

    if (!disabled) {
      await boss.schedule(queueName, cronExpression, {
        taskId,
        chatId,
        description,
        ...(agentId ? { agentId } : {}),
      } satisfies TaskData, { tz: timezone });
    } else {
      // Update the disabled record with any new metadata
      await clearDisabledTask(taskId);
      await persistDisabledTask({ taskId, chatId, description, cron: cronExpression, ...(agentId ? { agentId } : {}) });
    }

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
    extra?: Partial<Pick<TaskData, 'specialistId' | 'agentId' | 'spawningAgentId' | 'parentSpecialistId'>>,
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

    // Clean up persistent disabled state
    await clearDisabledTask(taskId);
  }

  /**
   * Disable a scheduled task without deleting it.
   * The task remains in the database but won't run on schedule.
   */
  async disableTask(taskId: string): Promise<void> {
    await this.disableSchedule(taskId);
  }

  private async disableSchedule(taskId: string): Promise<void> {
    const boss = await getBoss();
    const schedules = await boss.getSchedules();

    for (const schedule of schedules) {
      if (!schedule.name.startsWith(TASK_QUEUE_PREFIX)) continue;
      const data = (schedule.data ?? {}) as TaskData;
      if (data.taskId === taskId) {
        await boss.unschedule(schedule.name, schedule.cron);

        // Cancel any jobs already queued (created/retry state) that pg-boss
        // may have enqueued before unschedule took effect.
        const pendingJobs = await boss.findJobs<TaskData>(schedule.name);
        for (const job of pendingJobs) {
          if (job.state === 'created' || job.state === 'retry') {
            await boss.cancel(schedule.name, job.id);
          }
        }

        // Persist disabled state with full task metadata for later re-enable
        await persistDisabledTask({
          taskId,
          chatId: data.chatId ?? '',
          description: data.description ?? '',
          cron: schedule.cron,
          ...(data.agentId ? { agentId: data.agentId } : {}),
        });
      }
    }

    console.log(`[Scheduler] Task ${taskId} disabled.`);
  }

  /**
   * Enable a previously disabled scheduled task.
   */
  async enableTask(taskId: string): Promise<void> {
    await this.enableSchedule(taskId);
  }

  private async enableSchedule(taskId: string): Promise<void> {
    // Find the task in the disabled store
    const disabledJobs = await getDisabledTaskJobs();
    const job = disabledJobs.find((j) => j.data.taskId === taskId);

    if (!job) {
      console.error(`[Scheduler] Cannot enable task ${taskId}: not found in disabled store`);
      return;
    }

    const { chatId, description, cron, agentId } = job.data;

    // Remove from disabled store first so upsertSchedule will schedule it
    await clearDisabledTask(taskId);

    // Reschedule with original parameters
    await this.upsertSchedule(taskId, chatId, description, cron, agentId);
    console.log(`[Scheduler] Task ${taskId} enabled.`);
  }

  /**
   * Cancel a running specialist by its specialistId.
   * When called from the bot process the AbortController is signalled directly.
   * When called from Next.js the cancel request is forwarded to the bot via
   * the SCHEDULER_REQUEST_QUEUE so it can reach the in-process registry.
   */
  async cancelSpecialist(specialistId: string): Promise<void> {
    if (this.taskRunFn) {
      // We are the bot process — signal directly.
      const { cancellationRegistry } = await import('../agent/cancellation');
      const { updateJobStatus } = await import('../db/jobs');
      cancellationRegistry.cancel(specialistId);
      await updateJobStatus(specialistId, 'failed', undefined, 'Cancelled via dashboard');
      return;
    }

    // We are the Next.js process — forward to the bot via pg-boss.
    const boss = await getBoss();
    await boss.createQueue(SCHEDULER_REQUEST_QUEUE);
    await boss.send(SCHEDULER_REQUEST_QUEUE, {
      op: 'cancel',
      taskId: specialistId, // reuse taskId field for routing; specialistId is the real key
      specialistId,
    } satisfies ScheduleRequestJob);
  }

  /**
   * Execute a scheduled task immediately, bypassing the normal schedule.
   */
  async executeNow(taskId: string): Promise<void> {
    if (!this.taskRunFn) {
      const boss = await getBoss();
      await boss.createQueue(SCHEDULER_REQUEST_QUEUE);
      await boss.send(SCHEDULER_REQUEST_QUEUE, {
        op: 'execute',
        taskId,
      } satisfies ScheduleRequestJob);
      return;
    }

    // Get task details and execute immediately
    const schedules = await this.getSchedules();
    const task = schedules.find((s) => s.taskId === taskId);

    if (!task) {
      console.error(`[Scheduler] Cannot execute task ${taskId}: not found`);
      return;
    }

    const queueName = `${TASK_QUEUE_PREFIX}${taskId}`;
    const boss = await getBoss();
    await boss.createQueue(queueName);

    // Send directly to the queue for immediate execution
    await boss.send(queueName, {
      taskId,
      chatId: task.chatId,
      description: task.description,
      ...(task.agentId ? { agentId: task.agentId } : {}),
    } satisfies TaskData);

    console.log(`[Scheduler] Task ${taskId} queued for immediate execution.`);
  }

  /**
   * List all active scheduled tasks for the given chatId (or all if omitted).
   * Reads directly from pgboss.schedule.
   */
  async getSchedules(chatId?: string): Promise<ScheduleView[]> {
    const boss = await getBoss();
    const all = await boss.getSchedules();
    const timezone = configManager.get().timezone ?? 'UTC';

    const active: ScheduleView[] = all
      .filter((s) => s.name.startsWith(TASK_QUEUE_PREFIX))
      .map((s) => {
        const data = (s.data ?? {}) as TaskData;
        const taskId = data.taskId ?? '';
        return {
          taskId,
          chatId: data.chatId ?? '',
          description: data.description ?? '',
          agentId: data.agentId,
          cron: s.cron,
          nextRunAt: computeNextRun(s.cron, timezone)?.toISOString() ?? null,
          enabled: true,
        };
      });

    const disabledJobs = await getDisabledTaskJobs();
    const disabled: ScheduleView[] = disabledJobs.map((j) => ({
      taskId: j.data.taskId,
      chatId: j.data.chatId ?? '',
      description: j.data.description ?? '',
      agentId: j.data.agentId,
      cron: j.data.cron,
      nextRunAt: null,
      enabled: false,
    }));

    // Merge: disabled tasks override any active entry with the same taskId
    const activeFiltered = active.filter((a) => !disabled.some((d) => d.taskId === a.taskId));
    const merged = [...activeFiltered, ...disabled];

    return merged.filter((s) => !chatId || s.chatId === chatId);
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
          agentId: data.agentId,
          runAt: job.startAfter.toISOString(),
          state: job.state,
        };
      })
      .filter((t) => !chatId || t.chatId === chatId);
  }

  /**
   * Send a workflow node execution job to pg-boss.
   * Safe to call from any process.
   */
  async sendWorkflowNodeJob(data: import('@/lib/workflow/engine').WorkflowNodeJobData): Promise<void> {
    const boss = await getBoss();
    await boss.createQueue(WORKFLOW_NODE_QUEUE);
    await boss.send(WORKFLOW_NODE_QUEUE, data as unknown as object, {
      singletonKey: data.runNodeId, // prevent duplicate execution on recovery
    });
  }

  /**
   * Send a workflow HITL resume job to pg-boss.
   * Safe to call from any process.
   */
  async sendWorkflowResumeJob(data: import('@/lib/workflow/engine').WorkflowResumeJobData): Promise<void> {
    const boss = await getBoss();
    await boss.createQueue(WORKFLOW_RESUME_QUEUE);
    await boss.send(WORKFLOW_RESUME_QUEUE, data as unknown as object);
  }

  /**
   * Register pg-boss workers for workflow orchestration queues.
   * Called only from the bot process (inside initialize()).
   */
  private async initWorkflowQueues(): Promise<void> {
    const boss = await getBoss();

    await boss.createQueue(WORKFLOW_NODE_QUEUE);
    await boss.createQueue(WORKFLOW_RESUME_QUEUE);

    if (this.registeredQueues.has(WORKFLOW_NODE_QUEUE)) return;
    this.registeredQueues.add(WORKFLOW_NODE_QUEUE);
    this.registeredQueues.add(WORKFLOW_RESUME_QUEUE);

    await boss.work(WORKFLOW_NODE_QUEUE, { localConcurrency: 5 }, async (jobs: Job[]) => {
      const job = jobs[0];
      if (!job) return;
      // Lazy import to avoid circular dependency at module load time
      const { workflowEngine } = await import('@/lib/workflow/engine');
      await workflowEngine.executeNode(job.data as unknown as import('@/lib/workflow/engine').WorkflowNodeJobData);
    });

    await boss.work(WORKFLOW_RESUME_QUEUE, async (jobs: Job[]) => {
      const job = jobs[0];
      if (!job) return;
      const { workflowEngine } = await import('@/lib/workflow/engine');
      await workflowEngine.executeResumeJob(job.data as unknown as import('@/lib/workflow/engine').WorkflowResumeJobData);
    });

    console.log('[Scheduler] Workflow queues registered.');
  }

  private async registerWorker(queueName: string, runFn: TaskRunFn): Promise<void> {
    if (this.registeredQueues.has(queueName)) return;

    const boss = await getBoss();
    this.registeredQueues.add(queueName);

    await boss.work(
      queueName,
      async (jobs: Job<TaskData>[]) => {
        const job = jobs[0];
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
      /* Preventing excessive logging
      console.log(
        `[Scheduler] Synced ${taskSchedules.length} task queues from schedules table.`,
      );
      */
    }
  }
}

export const schedulerService = new SchedulerService();
