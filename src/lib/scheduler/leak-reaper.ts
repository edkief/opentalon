/**
 * Periodic reaper for leaked jobs: rows marked `running` that nothing in this
 * process is running any more.
 *
 * Every path that executes a job registers it in `cancellationRegistry` for the
 * length of the run (llm-executor, executeSpecialist, the harness runner), so
 * with one worker per deployment (see failInterruptedJobs) that registry is
 * the exact set of live jobs. A `running` row missing from it has leaked: the
 * run ended without recording a result, e.g. an error that skipped
 * updateJobStatus. The startup sweep covers jobs killed by a restart; this
 * covers the ones lost while the process keeps going.
 *
 * A row can be legitimately `running` but unregistered for a moment: before the
 * run registers (tool setup in runScheduledTask) and after it unregisters but
 * before the final status write. So a job is only reaped when it is missing on
 * two consecutive sweeps, an interval apart.
 *
 * `pending` rows are never reaped here: a pending job may be waiting its turn
 * in the in-memory chat queue, behind a long turn, and isn't registered yet.
 */

/** How often the reaper runs. Two sweeps must agree, so a leak is reaped within 2× this. */
export const LEAK_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface LeakSweepPlan {
  /** Missing on this sweep and the previous one: fail these. */
  reap: string[];
  /** Missing for the first time: check again next sweep. */
  suspects: Set<string>;
}

/**
 * Decides one sweep. Pure, so the two-strike rule can be tested without a DB.
 *
 * @param prevSuspects ids found missing on the previous sweep
 * @param runningIds   ids of jobs currently marked `running`
 * @param isLive       whether this process is running the job
 */
export function planLeakSweep(
  prevSuspects: ReadonlySet<string>,
  runningIds: readonly string[],
  isLive: (id: string) => boolean,
): LeakSweepPlan {
  const reap: string[] = [];
  const suspects = new Set<string>();
  for (const id of runningIds) {
    if (isLive(id)) continue;
    if (prevSuspects.has(id)) reap.push(id);
    else suspects.add(id);
  }
  return { reap, suspects };
}

let suspects = new Set<string>();

/** Runs one sweep: fails confirmed leaks and lets each affected batch dispatch. */
export async function sweepLeakedJobs(): Promise<string[]> {
  // Lazy: keeps planLeakSweep importable without the DB/runtime, and avoids
  // an import cycle (specialist-batch imports the scheduler).
  const { getRunningJobIds, failLostJobs } = await import('../db/jobs');
  const { cancellationRegistry } = await import('../agent/cancellation');

  const plan = planLeakSweep(suspects, await getRunningJobIds(), (id) => cancellationRegistry.isRegistered(id));
  suspects = plan.suspects;
  if (plan.reap.length === 0) return [];

  const lost = await failLostJobs(plan.reap);
  if (lost.length === 0) return [];
  console.warn(`[Scheduler] Reaped ${lost.length} leaked job(s) with no live run: ${lost.map((j) => j.id).join(', ')}`);

  const { notifyBatchMemberComplete } = await import('../agent/specialist-batch');
  for (const j of lost.filter((j) => j.batchId)) {
    await notifyBatchMemberComplete(j.id).catch((err) =>
      console.error(`[Scheduler] Batch dispatch after reaping job ${j.id} failed:`, err),
    );
  }
  return lost.map((j) => j.id);
}

/** Starts the periodic sweep once per process (guarded across dev hot-reloads). */
export function startLeakReaper(intervalMs = LEAK_SWEEP_INTERVAL_MS): void {
  const g = globalThis as typeof globalThis & { __leakReaperStarted?: boolean };
  if (g.__leakReaperStarted) return;
  g.__leakReaperStarted = true;
  setInterval(() => {
    sweepLeakedJobs().catch((err) => console.error('[Scheduler] Leak sweep failed:', err));
  }, intervalMs).unref();
}
