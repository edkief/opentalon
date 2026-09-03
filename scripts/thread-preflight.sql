-- Pre-flight and soak-window queries for migration 0026 (epic #41, T2).
--
-- The backfill designates one (chat_id, agent_id) pair per chat as primary and
-- gives it the canonical thread id. Everything else becomes an archived
-- `<chat_id>#<agent_id>` thread. Queries 1 and 2 measure, on real data, how often
-- that choice is decided by something other than the chat's active agent — those
-- are the users who could perceive a change when reads flip in T4 (#45).
--
-- Run 1 and 2 BEFORE deploying 0026, and 3-5 after, during the soak window:
--   psql "$DATABASE_URL" -f scripts/thread-preflight.sql

\echo '== 1. Chats whose active agent has no history =='
-- agent_state names an agent with zero rows, so the primary thread is decided by
-- recency instead. Post-T4 these users see another agent's history in a thread
-- that reads empty today — a gain in continuity, but a visible surprise.
SELECT count(*) AS chats
FROM agent_state s
WHERE NOT EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.chat_id = s.chat_id AND c.agent_id = s.agent_name
);

\echo '== 2. Chats where the recency tiebreak is close =='
-- Two agents last used within 10 minutes of each other. Where agent_state also
-- fails to match, the primary is effectively arbitrary, and the conversation the
-- user is actually in could end up archived. This is the number that matters.
WITH agg AS (
  SELECT chat_id, agent_id, max(created_at) AS last_at
    FROM conversations WHERE agent_id IS NOT NULL GROUP BY 1, 2
),
ranked AS (
  SELECT chat_id, agent_id, last_at,
         row_number() OVER (PARTITION BY chat_id ORDER BY last_at DESC, agent_id ASC) AS rn
    FROM agg
)
SELECT count(*) FILTER (WHERE close)                       AS close_calls,
       count(*) FILTER (WHERE close AND NOT pointer_match) AS close_and_unanchored
FROM (
  SELECT a.chat_id,
         (b.last_at IS NOT NULL AND a.last_at - b.last_at < interval '10 minutes') AS close,
         EXISTS (SELECT 1 FROM agent_state s JOIN agg g ON g.chat_id = s.chat_id
                  AND g.agent_id = s.agent_name WHERE s.chat_id = a.chat_id)       AS pointer_match
    FROM ranked a LEFT JOIN ranked b ON b.chat_id = a.chat_id AND b.rn = 2
   WHERE a.rn = 1
) x;

\echo '== 3. Post-migration: rows still missing a thread_id (expect 0, 0) =='
SELECT (SELECT count(*) FROM conversations      WHERE thread_id IS NULL) AS conversations,
       (SELECT count(*) FROM conversation_steps WHERE thread_id IS NULL) AS steps;

\echo '== 4. Post-migration: exactly one active canonical thread per chat (expect 0) =='
SELECT count(*) AS chats_violating
FROM (
  SELECT chat_id, count(*) FILTER (WHERE id = chat_id AND status = 'active') AS n
    FROM threads GROUP BY chat_id
) t
WHERE n <> 1;

\echo '== 5. Post-migration: thread shape =='
SELECT channel, status, count(*) FROM threads GROUP BY 1, 2 ORDER BY 1, 2;
