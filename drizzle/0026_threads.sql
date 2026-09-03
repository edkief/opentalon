-- 0026 — explicit conversation threads (epic #41, T2).
--
-- Additive only. Nothing reads or writes `threads` yet; this ships and is
-- observed on its own so the assignment below can be checked against real rows
-- before T4 makes anything depend on it.
--
-- Production applies this once, via the migrator in src/instrumentation.ts:12
-- (which only runs when NODE_ENV=production); dev databases are built with
-- `drizzle-kit push` instead and never execute these files. The DDL is therefore
-- written with IF NOT EXISTS so the file can also be applied by hand to a
-- push-built database without tripping over objects that are already there.

CREATE TABLE IF NOT EXISTS "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"channel" text NOT NULL,
	"title" text,
	"route" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text,
	"last_activity_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "conversation_steps" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "pending_turns" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_chat_activity_idx" ON "threads" USING btree ("chat_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_channel_idx" ON "threads" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_steps_thread_created_idx" ON "conversation_steps" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_thread_created_idx" ON "conversations" USING btree ("thread_id","created_at");

--> statement-breakpoint
-- >>> BACKFILL (scripts/test-thread-backfill.ts executes everything below this
-- marker against a fixture database — keep the marker and keep this one
-- statement idempotent).
--
-- Rule: one thread per distinct (chat_id, agent_id), with the currently-active
-- agent's pair designated primary. The primary pair keeps the canonical id
-- (thread_id = chat_id), so the next message a user sends behaves
-- bit-identically. Every other agent's history becomes an archived
-- `<chat_id>#<agent_id>` thread — visible later in a picker, never loaded into a
-- live turn. That is the whole no-retroactive-merge guarantee: existing
-- per-agent histories are never merged, and thread sharing only applies to
-- threads used after the read flip.
--
-- This is deliberately ONE statement with data-modifying CTEs, so `conversations`
-- and `conversation_steps` derive thread_id from the same `assign` relation off
-- one snapshot. Two statements could diverge, and then /status and /compact would
-- report different context sizes for the same thread. Postgres runs every
-- data-modifying CTE exactly once and to completion, whether or not the primary
-- query reads it.
--
-- Every UPDATE is guarded by `thread_id IS NULL`, so re-running is a no-op.
WITH agg AS (
  -- Every (chat, agent) pair that has history, across both tables.
  SELECT chat_id, agent_id, max(last_at) AS last_at FROM (
    SELECT chat_id, agent_id, max(created_at) AS last_at
      FROM conversations WHERE agent_id IS NOT NULL GROUP BY 1, 2
    UNION ALL
    SELECT chat_id, agent_id, max(created_at)
      FROM conversation_steps WHERE agent_id IS NOT NULL GROUP BY 1, 2
  ) p GROUP BY 1, 2
),
chats AS (
  -- Every chat we know about at all, including ones with only null-agent rows or
  -- only an agent_state pointer. Anything missing here would keep a null
  -- thread_id forever.
  SELECT chat_id FROM conversations
  UNION SELECT chat_id FROM conversation_steps
  UNION SELECT chat_id FROM pending_turns
  UNION SELECT chat_id FROM agent_state
),
primary_pair AS (
  SELECT c.chat_id, COALESCE(
    -- 1. The agent the chat is actually on.
    (SELECT a.agent_id FROM agg a
       JOIN agent_state s ON s.chat_id = a.chat_id AND s.agent_name = a.agent_id
      WHERE a.chat_id = c.chat_id LIMIT 1),
    -- 2. Otherwise the most recently used pair. The agent_id tiebreak is not
    --    decoration: two agents can share a max(created_at), and without it a
    --    re-run could pick the other one.
    (SELECT a.agent_id FROM agg a WHERE a.chat_id = c.chat_id
      ORDER BY a.last_at DESC, a.agent_id ASC LIMIT 1),
    -- 3. A chat with a pointer but no history yet.
    (SELECT s.agent_name FROM agent_state s WHERE s.chat_id = c.chat_id)
  ) AS agent_id
  FROM chats c
),
assign AS (
  SELECT a.chat_id, a.agent_id, a.last_at,
         CASE WHEN a.agent_id = p.agent_id
              THEN a.chat_id
              ELSE a.chat_id || '#' || a.agent_id END AS thread_id,
         (a.agent_id = p.agent_id) AS is_primary
    FROM agg a JOIN primary_pair p USING (chat_id)
  UNION ALL
  -- Legacy rows written before agent_id existed, and specialist-only steps (which
  -- legitimately carry a null agent_id and are keyed by specialist_id instead),
  -- belong to their chat's primary thread. Migration 007 made the same reading.
  SELECT chat_id, NULL::text, NULL::timestamp, chat_id, true FROM chats
),
thread_rows AS (
  -- The primary pair and the synthetic null-agent row share a thread id.
  SELECT thread_id, chat_id, bool_or(is_primary) AS is_primary, max(last_at) AS last_at
    FROM assign GROUP BY thread_id, chat_id
),
ins AS (
  INSERT INTO threads (id, chat_id, channel, status, origin, last_activity_at)
  SELECT tr.thread_id, tr.chat_id,
         -- Channel is derived once, here, and stored, so nothing downstream has
         -- to sniff the shape of a chatId again. Mirrors resolveSender
         -- (src/lib/channels/registry.ts:65-84), plus the `web:<uuid>` form T6
         -- will mint.
         CASE WHEN tr.chat_id = 'web' OR tr.chat_id LIKE 'web:%' THEN 'web'
              WHEN tr.chat_id LIKE 'email:%'  THEN 'email'
              WHEN tr.chat_id LIKE 'embed:%'  THEN 'embed'
              WHEN tr.chat_id ~ '^-?[0-9]+$'  THEN 'telegram'
              ELSE 'system' END,
         CASE WHEN tr.is_primary THEN 'active' ELSE 'archived' END,
         'backfill',
         COALESCE(tr.last_at, s.updated_at)
    FROM thread_rows tr
    LEFT JOIN agent_state s ON s.chat_id = tr.chat_id
  ON CONFLICT (id) DO NOTHING
),
u1 AS (
  UPDATE conversations c SET thread_id = a.thread_id
    FROM assign a
   WHERE c.chat_id = a.chat_id
     AND c.agent_id IS NOT DISTINCT FROM a.agent_id
     AND c.thread_id IS NULL
),
u2 AS (
  UPDATE conversation_steps cs SET thread_id = a.thread_id
    FROM assign a
   WHERE cs.chat_id = a.chat_id
     AND cs.agent_id IS NOT DISTINCT FROM a.agent_id
     AND cs.thread_id IS NULL
),
-- A pending turn and an active-agent pointer both belong to their chat's primary
-- thread, whose id is the chat id by construction.
u3 AS (UPDATE pending_turns SET thread_id = chat_id WHERE thread_id IS NULL),
u4 AS (UPDATE agent_state   SET thread_id = chat_id WHERE thread_id IS NULL)
SELECT 1;
