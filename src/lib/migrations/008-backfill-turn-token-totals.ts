import type { WorkspaceMigration } from './runner';

const migration: WorkspaceMigration = {
  id: 'backfill-turn-token-totals',
  description:
    'Recompute conversations.*_tokens from the sum of that turn\'s conversation_steps. ' +
    'Pre-fix rows stored only the FINAL step\'s usage (AI SDK v6 result.usage), undercounting ' +
    'multi-step turns; the per-step rows hold the ground truth, so we re-derive the true totals.',
  async run() {
    const { sql } = await import('drizzle-orm');
    const { db } = await import('../db');

    // Sum every step of a turn (all phases; specialist-only steps carry a NULL
    // turn_id and are naturally excluded — matching the dashboard's per-round
    // total). Only assistant rows carry token totals, so only they are updated;
    // turns with no persisted steps (legacy / failed-persist) are left untouched
    // because the INNER join drops them.
    const result = await db.execute(sql`
      UPDATE conversations c
      SET
        input_tokens       = s.input_tokens,
        output_tokens      = s.output_tokens,
        cache_read_tokens  = s.cache_read_tokens,
        cache_write_tokens = s.cache_write_tokens,
        reasoning_tokens   = s.reasoning_tokens
      FROM (
        SELECT
          turn_id,
          SUM(COALESCE(input_tokens, 0))        AS input_tokens,
          SUM(COALESCE(output_tokens, 0))       AS output_tokens,
          SUM(COALESCE(cache_read_tokens, 0))   AS cache_read_tokens,
          SUM(COALESCE(cache_write_tokens, 0))  AS cache_write_tokens,
          SUM(COALESCE(reasoning_tokens, 0))    AS reasoning_tokens
        FROM conversation_steps
        WHERE turn_id IS NOT NULL
        GROUP BY turn_id
      ) s
      WHERE c.turn_id = s.turn_id
        AND c.role = 'assistant'
    `);

    // postgres.js exposes affected rows on `.count`; keep `.rowCount` as a
    // fallback in case the driver changes.
    const res = result as unknown as { count?: number; rowCount?: number };
    const count = res.count ?? res.rowCount ?? 0;
    console.log(
      `[Migration] Recomputed token totals for ${count} assistant turn row(s) from conversation_steps`,
    );
  },
};

export default migration;
