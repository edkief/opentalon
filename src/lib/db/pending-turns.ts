import { db } from './index';
import { pendingTurns, type NewPendingTurn, type PendingTurn } from './schema';
import { eq, sql } from 'drizzle-orm';

/**
 * Crash-recovery bookkeeping for in-flight agent turns.
 *
 * A row is written before `llmExecutor.chat()` runs (recordPendingTurn) and
 * deleted the moment the turn finishes — success or handled error — via a
 * `finally` in executeTurn. A `finally` runs on normal completion and on caught
 * errors but NOT when the process is killed mid-turn, so any row that survives a
 * restart is exactly a turn that was in flight when the process died. Startup
 * recovery lists those rows and re-drives them. See src/lib/telegram/resume-turn.ts.
 */

export async function recordPendingTurn(data: NewPendingTurn): Promise<void> {
  try {
    await db
      .insert(pendingTurns)
      .values(data)
      .onConflictDoUpdate({
        target: pendingTurns.turnId,
        set: { updatedAt: new Date() },
      });
  } catch (error) {
    // Non-fatal: failing to record a pending turn only forfeits crash recovery
    // for this one turn — it must never block the turn itself from running.
    console.error('[DB] Failed to record pending turn:', error);
  }
}

/** Remove a turn's recovery record once it has completed (reply delivered). */
export async function clearPendingTurn(turnId: string): Promise<void> {
  try {
    await db.delete(pendingTurns).where(eq(pendingTurns.turnId, turnId));
  } catch (error) {
    console.error('[DB] Failed to clear pending turn:', error);
  }
}

/** All turns still marked in-flight — the recovery candidates on startup. */
export async function getInflightTurns(): Promise<PendingTurn[]> {
  try {
    return await db.select().from(pendingTurns);
  } catch (error) {
    console.error('[DB] Failed to load in-flight turns:', error);
    return [];
  }
}

/**
 * Atomically bump the recovery attempt counter and return the new value, so a
 * turn that reliably crashes the process on resume can be abandoned after a few
 * tries instead of crash-looping forever.
 */
export async function incrementTurnAttempts(turnId: string): Promise<number> {
  try {
    const [row] = await db
      .update(pendingTurns)
      .set({ attempts: sql`${pendingTurns.attempts} + 1`, updatedAt: new Date() })
      .where(eq(pendingTurns.turnId, turnId))
      .returning({ attempts: pendingTurns.attempts });
    return row?.attempts ?? 0;
  } catch (error) {
    console.error('[DB] Failed to increment turn attempts:', error);
    return 0;
  }
}
