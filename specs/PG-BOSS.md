For **100 schedules**, the "Ticker" pattern is absolutely an anti-pattern. You'd be building a scheduler on top of a scheduler, which adds unnecessary moving parts and database queries.

At your scale, using `pg-boss` to handle the timing is exactly what it’s built for. The "anti-pattern" fear usually stems from how we bridge the gap between **persistent database state** (the schedule) and **active memory** (the worker).

Since you are expecting around 100 schedules, the **Dynamic Registration** approach I showed previously is your best bet, but let's refine it to be even cleaner.

### Why your intuition is right

By letting `pg-boss` manage the schedules:

* **Reliability:** Postgres handles the clock. If your server is down for 5 minutes, `pg-boss` knows exactly what it missed the second it boots back up.
* **Simplicity:** Your code only cares about "What do I do when this triggers?" rather than "When should this trigger?"

### The Refined "100 Schedules" Implementation

Since you have a manageable number of tasks, the most robust way to handle this is to ensure that **every time the server starts**, it synchronizes its "in-memory" workers with the "database-persisted" schedules.

```typescript
class SchedulerService {
  /**
   * Run this once on startup.
   * It ensures that for every schedule in Postgres, there is a worker in Node.
   */
  async initialize(runFn: TaskRunFn): Promise<void> {
    const boss = await getBoss();
    await boss.start();

    // 1. Fetch all schedules currently in the DB
    const schedules = await boss.getSchedules();

    // 2. Filter for your specific app's tasks (using a prefix)
    const taskSchedules = schedules.filter(s => s.name.startsWith('task:'));

    for (const schedule of taskSchedules) {
      await this.registerWorker(schedule.name, runFn);
    }

    console.log(`[Scheduler] Synced ${taskSchedules.length} workers from DB.`);
  }

  /**
   * A helper to attach the logic to a queue name.
   */
  private async registerWorker(queueName: string, runFn: TaskRunFn) {
    const boss = await getBoss();
    
    // We only register if it's not already being worked on this instance
    await boss.work(queueName, async ([job]) => {
      const { taskId, chatId, description } = job.data as TaskData;
      await runFn(chatId, taskId, description);
    });
  }

  /**
   * When creating a NEW task, we save to DB AND register the worker immediately.
   */
  async scheduleTask(taskId: string, chatId: string, description: string, cron: string, runFn: TaskRunFn) {
    const boss = await getBoss();
    const queueName = `task:${taskId}`;

    // Persist to Postgres
    await boss.schedule(queueName, cron, { taskId, chatId, description });

    // Register worker in current process memory so it starts working without a reboot
    await this.registerWorker(queueName, runFn);
  }
}

```

### Addressing the "Anti-Pattern" Concern

The reason this feels slightly clunky is that `pg-boss` doesn't have a `boss.work('*')` feature. However, registering 100 workers is computationally trivial for Node.js. Each worker is just an entry in an object that `pg-boss` iterates over when it polls Postgres.

**What this achieves:**

1. **Single Source of Truth:** Your schedules live in Postgres.
2. **No Missing Jobs:** If the server restarts, `initialize()` ensures all 100 tasks have workers ready to catch their next (or missed) tick.
3. **Clean Code:** Your business logic doesn't need to know about timers; it just reacts to jobs.

---

### A Final Check on `scheduleOnce`

For your `scheduleOnce` tasks, you **should** keep using a single, static queue (e.g., `once-off-tasks`). Since these aren't recurring schedules, they don't collide in the `pgboss.schedule` table.

```typescript
// For one-offs, this is all you need. No dynamic registration required.
await boss.work('once-off-tasks', async ([job]) => { ... });

// To trigger:
await boss.send('once-off-tasks', data, { startAfter: 600 });

```