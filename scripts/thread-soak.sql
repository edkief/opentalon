-- Soak-window queries for the T3 dual write (#44), run AFTER deploying the
-- write path. These are the acceptance criteria the PR left as `Part of #44`
-- rather than `Closes` — they can only be answered by rows a deployed pod wrote.
--
--   psql "$DATABASE_URL" -v deploy="'2026-09-04 00:00:00+00'" -f scripts/thread-soak.sql
--
-- `deploy` is the timestamp the dual-write image started serving. Rows older
-- than it are expected to carry the backfilled value from 0026 (or, for
-- pending_turns, a null the resume path deliberately tolerates), so every
-- criterion below is scoped to rows created after it. Read-only.

\if :{?deploy}
\else
  \set deploy '(now() - interval ''24 hours'')'
  \echo '!! no -v deploy=... given; defaulting to the last 24 hours'
\endif

\echo '== 1. Rows written since deploy with a null thread_id (expect 0,0,0,0) =='
-- The core no-null criterion. agent_state is keyed on updated_at because the
-- row is upserted in place and has no created_at.
SELECT (SELECT count(*) FROM conversations      WHERE thread_id IS NULL AND created_at > :deploy) AS conversations,
       (SELECT count(*) FROM conversation_steps WHERE thread_id IS NULL AND created_at > :deploy) AS steps,
       (SELECT count(*) FROM pending_turns      WHERE thread_id IS NULL AND created_at > :deploy) AS pending_turns,
       (SELECT count(*) FROM agent_state        WHERE thread_id IS NULL AND updated_at > :deploy) AS agent_state;

\echo '== 2. Which writer leaked, if 1 is non-zero =='
-- Only meaningful when query 1 reports a non-zero count. Splits the nulls by
-- channel shape and by whether the row is specialist-only (null agent_id), which
-- is what distinguishes a missed call site from missed specialist plumbing.
SELECT 'conversations' AS tbl,
       CASE WHEN chat_id = 'web' OR chat_id LIKE 'web:%' THEN 'web'
            WHEN chat_id LIKE 'email:%' THEN 'email'
            WHEN chat_id LIKE 'embed:%' THEN 'embed'
            WHEN chat_id ~ '^-?[0-9]+$' THEN 'telegram'
            ELSE 'system' END AS channel,
       agent_id IS NULL AS specialist_only,
       count(*), min(created_at) AS first_seen, max(created_at) AS last_seen
  FROM conversations WHERE thread_id IS NULL AND created_at > :deploy
 GROUP BY 1, 2, 3
UNION ALL
SELECT 'conversation_steps',
       CASE WHEN chat_id = 'web' OR chat_id LIKE 'web:%' THEN 'web'
            WHEN chat_id LIKE 'email:%' THEN 'email'
            WHEN chat_id LIKE 'embed:%' THEN 'embed'
            WHEN chat_id ~ '^-?[0-9]+$' THEN 'telegram'
            ELSE 'system' END,
       agent_id IS NULL,
       count(*), min(created_at), max(created_at)
  FROM conversation_steps WHERE thread_id IS NULL AND created_at > :deploy
 GROUP BY 1, 2, 3
 ORDER BY 1, 2;

\echo '== 3. Stamped thread_ids with no threads row (expect 0) =='
-- There is no FK from thread_id to threads.id by design, so a resolver that
-- returns an id without the ensure step creating the row fails silently today
-- and becomes a missing conversation at the T4 read flip.
SELECT (SELECT count(DISTINCT c.thread_id) FROM conversations c
         WHERE c.created_at > :deploy AND c.thread_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = c.thread_id))  AS orphan_conversations,
       (SELECT count(DISTINCT s.thread_id) FROM conversation_steps s
         WHERE s.created_at > :deploy AND s.thread_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = s.thread_id))  AS orphan_steps;

\echo '== 4. Threads minted since deploy, by channel and origin =='
-- Shape check: new threads should be origin=inbound/dashboard, never 'backfill'
-- (0026 is done). A channel of 'system' here means a chat_id shape the resolver
-- did not recognise.
SELECT channel, origin, status, count(*)
  FROM threads WHERE created_at > :deploy
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '== 5. Thread ids that are not their own chat_id (root-thread deviation) =='
-- Before T6 mints per-thread web ids, essentially every live thread should still
-- be a root thread (thread_id = chat_id). Anything else written since deploy is
-- either an archived-agent thread being written to, or a resolver bug.
SELECT t.channel, count(*) AS rows_written, min(c.thread_id) AS example
  FROM conversations c JOIN threads t ON t.id = c.thread_id
 WHERE c.created_at > :deploy AND c.thread_id <> c.chat_id
 GROUP BY 1 ORDER BY 2 DESC;

\echo '== 6. Per-chat divergence between the two conversation tables (expect 0) =='
-- The same chat writing its messages to one thread and its steps to another
-- would split a transcript in half at the read flip.
SELECT count(*) AS chats_diverging FROM (
  SELECT chat_id FROM conversations      WHERE created_at > :deploy AND thread_id IS NOT NULL
   GROUP BY chat_id HAVING count(DISTINCT thread_id) > 1
  UNION
  SELECT c.chat_id FROM conversations c
    JOIN conversation_steps s ON s.chat_id = c.chat_id
   WHERE c.created_at > :deploy AND s.created_at > :deploy
     AND c.agent_id IS NOT DISTINCT FROM s.agent_id
     AND c.thread_id IS DISTINCT FROM s.thread_id
   GROUP BY c.chat_id
) x;
