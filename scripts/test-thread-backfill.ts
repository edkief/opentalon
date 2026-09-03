/**
 * The migration-0026 backfill test (epic #41, T2).
 *
 * The review question for that migration is "is the primary-pair rule correct?",
 * so this does not restate the rule: it reads `drizzle/0026_threads.sql`, slices
 * out everything below the BACKFILL marker, and runs *that* against a fixture.
 * A paraphrase here would pass while the shipped SQL was wrong.
 *
 * Needs a live Postgres carrying the current schema — the test applies the
 * backfill itself, so the migration need not have run:
 *   pnpm deps:up && pnpm db:push && pnpm test:thread-backfill
 * Skips (exit 0) when DATABASE_URL is unset or unreachable, so it is safe in a
 * checkout without services running.
 *
 * The backfill is table-wide by nature, so running this also assigns thread ids
 * to any other rows in the database that still lack one — which is what the
 * migration would have done anyway, and is why every UPDATE in it is guarded by
 * `thread_id IS NULL`. Fixture rows are deleted at the end.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

function ok(name: string, cond: boolean): void {
  eq(name, cond, true);
}

async function reachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const probe = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 3 });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

/** Everything below the marker in the shipped migration — the statement under test. */
function loadBackfillSql(): string {
  const file = join(process.cwd(), 'drizzle', '0026_threads.sql');
  const sql = readFileSync(file, 'utf-8');
  const marker = sql.indexOf('-- >>> BACKFILL');
  if (marker === -1) {
    throw new Error(`No '-- >>> BACKFILL' marker in ${file} — did the migration get regenerated?`);
  }
  return sql.slice(marker);
}

const hex = (n: number): string => randomBytes(n).toString('hex').slice(0, n * 2);
const at = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);

async function main(): Promise<void> {
  console.log('=== Thread backfill (migration 0026) ===\n');

  if (!(await reachable())) {
    console.log('  ⊘ skipped: DATABASE_URL unset or Postgres unreachable');
    console.log('    start services with `pnpm deps:up && pnpm db:push`');
    process.exit(0);
  }

  const { db, pgClient } = await import('../src/lib/db');
  const { conversations, conversationSteps, agentState, pendingTurns, threads } = await import(
    '../src/lib/db/schema'
  );
  const { getConversationHistory } = await import('../src/lib/db/conversation');
  const { and, eq: dEq, inArray, isNull, sql } = await import('drizzle-orm');

  // One chat per branch of the rule, each with a real channel shape so the
  // derived `channel` column is exercised too.
  const C1 = `-99${Math.floor(Math.random() * 1e8)}`;      // telegram: active agent wins
  const C2 = `email:${hex(8)}`;                            // email: most-recent wins
  const C3 = `embed:t2test:${hex(8)}`;                     // embed: agent_state names a no-rows agent
  const C4 = `web:${randomUUID()}`;                        // web: null-agent + specialist rows
  const C5 = `-98${Math.floor(Math.random() * 1e8)}`;      // telegram: agent_state only, no history
  const chatIds = [C1, C2, C3, C4, C5];

  const cleanup = async (): Promise<void> => {
    await db.delete(conversations).where(inArray(conversations.chatId, chatIds));
    await db.delete(conversationSteps).where(inArray(conversationSteps.chatId, chatIds));
    await db.delete(pendingTurns).where(inArray(pendingTurns.chatId, chatIds));
    await db.delete(agentState).where(inArray(agentState.chatId, chatIds));
    await db.delete(threads).where(inArray(threads.chatId, chatIds));
  };

  await cleanup();

  try {
    // ── Fixture ───────────────────────────────────────────────────────────────
    const msg = (chatId: string, agentId: string | null, minutesAgo: number, content: string) => ({
      chatId,
      messageId: 0,
      role: 'user' as const,
      content,
      agentId,
      createdAt: at(minutesAgo),
    });

    await db.insert(conversations).values([
      // C1 — alpha is older but is the agent the chat is actually on.
      msg(C1, 'alpha', 90, 'c1 alpha one'),
      msg(C1, 'alpha', 80, 'c1 alpha two'),
      msg(C1, 'beta', 10, 'c1 beta'),
      // C2 — no pointer at all, so recency decides.
      msg(C2, 'alpha', 90, 'c2 alpha'),
      msg(C2, 'beta', 10, 'c2 beta'),
      // C3 — the pointer names an agent with no rows; falls through to recency.
      msg(C3, 'alpha', 90, 'c3 alpha'),
      msg(C3, 'beta', 10, 'c3 beta'),
      // C4 — legacy rows written before agent_id existed, plus one normal row.
      msg(C4, null, 90, 'c4 legacy'),
      msg(C4, 'alpha', 10, 'c4 alpha'),
    ]);

    await db.insert(conversationSteps).values([
      { chatId: C1, agentId: 'alpha', phase: 'main', stepIndex: 0, createdAt: at(80) },
      { chatId: C1, agentId: 'beta', phase: 'main', stepIndex: 0, createdAt: at(10) },
      // Specialist-only step: null agentId by design, keyed by specialistId.
      { chatId: C4, agentId: null, specialistId: 'spec-1', phase: 'specialist', stepIndex: 0, createdAt: at(5) },
    ]);

    await db.insert(pendingTurns).values({
      turnId: `t2test-${randomUUID()}`,
      chatId: C1,
      agentId: 'alpha',
      messageId: 0,
      scope: 'private',
      userContent: 'pending',
    });

    const c5UpdatedAt = at(45);
    await db.insert(agentState).values([
      { chatId: C1, agentName: 'alpha' },
      { chatId: C3, agentName: 'gamma' }, // names an agent with zero rows
      { chatId: C5, agentName: 'alpha', updatedAt: c5UpdatedAt },
    ]);

    // What the live read path returns today, for the parity assertion.
    const before = (await getConversationHistory(C1, 'alpha', 100)) as unknown as { id: number }[];
    const beforeIds = before.map((r) => r.id).sort((a, b) => a - b);

    // ── Run the shipped backfill ──────────────────────────────────────────────
    const backfill = loadBackfillSql();
    await pgClient.unsafe(backfill);

    // ── Assertions ────────────────────────────────────────────────────────────
    const threadRows = await db.select().from(threads).where(inArray(threads.chatId, chatIds));
    const byId = new Map(threadRows.map((t) => [t.id, t]));

    const idsFor = async (chatId: string, threadId: string): Promise<number[]> => {
      const rows = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(dEq(conversations.chatId, chatId), dEq(conversations.threadId, threadId)));
      return rows.map((r) => r.id).sort((a, b) => a - b);
    };

    console.log('\n-- primary-pair rule --');
    eq('C1 primary is the active agent, not the most recent', byId.get(C1)?.status, 'active');
    eq('C1 non-primary agent is archived', byId.get(`${C1}#beta`)?.status, 'archived');
    ok('C1 has no thread for the primary agent under a suffixed id', !byId.has(`${C1}#alpha`));

    eq('C2 falls back to the most recent pair', byId.get(`${C2}#alpha`)?.status, 'archived');
    ok('C2 primary holds beta (the recent one)', (await idsFor(C2, C2)).length === 1);

    eq('C3 pointer names a no-rows agent → recency decides', byId.get(`${C3}#alpha`)?.status, 'archived');
    ok('C3 mints no thread for the phantom agent', !byId.has(`${C3}#gamma`));

    console.log('\n-- parity --');
    eq('primary thread rows == pre-migration getConversationHistory rows', await idsFor(C1, C1), beforeIds);
    eq('archived thread holds exactly the other agent’s rows', (await idsFor(C1, `${C1}#beta`)).length, 1);

    console.log('\n-- null-agent rows --');
    eq('legacy null-agent rows land on the primary thread', (await idsFor(C4, C4)).length, 2);
    const specStep = await db
      .select({ threadId: conversationSteps.threadId })
      .from(conversationSteps)
      .where(dEq(conversationSteps.specialistId, 'spec-1'));
    eq('specialist-only step lands on the primary thread', specStep[0]?.threadId, C4);

    console.log('\n-- seeding and invariants --');
    ok('history-less chat still gets a thread', byId.has(C5));
    eq('its last_activity_at comes from agent_state', byId.get(C5)?.lastActivityAt?.getTime(), c5UpdatedAt.getTime());
    eq('origin is recorded', byId.get(C1)?.origin, 'backfill');

    for (const [chatId, channel] of [[C1, 'telegram'], [C2, 'email'], [C3, 'embed'], [C4, 'web'], [C5, 'telegram']] as const) {
      eq(`channel derived for ${channel}`, byId.get(chatId)?.channel, channel);
    }

    for (const chatId of chatIds) {
      const primaries = threadRows.filter((t) => t.chatId === chatId && t.id === chatId && t.status === 'active');
      eq(`exactly one active thread with id = chat_id (${chatId.slice(0, 12)}…)`, primaries.length, 1);
    }

    const orphanConv = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(and(inArray(conversations.chatId, chatIds), isNull(conversations.threadId)));
    eq('no conversations row left without a thread_id', orphanConv[0]?.n, 0);

    const orphanSteps = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversationSteps)
      .where(and(inArray(conversationSteps.chatId, chatIds), isNull(conversationSteps.threadId)));
    eq('no conversation_steps row left without a thread_id', orphanSteps[0]?.n, 0);

    const pt = await db
      .select({ threadId: pendingTurns.threadId })
      .from(pendingTurns)
      .where(dEq(pendingTurns.chatId, C1));
    eq('pending_turns points at the primary thread', pt[0]?.threadId, C1);
    const as = await db.select({ threadId: agentState.threadId }).from(agentState).where(dEq(agentState.chatId, C1));
    eq('agent_state points at the primary thread', as[0]?.threadId, C1);

    console.log('\n-- idempotence --');
    const snapshot = async (): Promise<string> => {
      const rows = await db
        .select({ id: conversations.id, threadId: conversations.threadId })
        .from(conversations)
        .where(inArray(conversations.chatId, chatIds))
        .orderBy(conversations.id);
      return JSON.stringify(rows);
    };
    const first = await snapshot();
    await pgClient.unsafe(backfill);
    eq('re-running the backfill changes no assignment', await snapshot(), first);
    const threadsAfter = await db.select({ id: threads.id }).from(threads).where(inArray(threads.chatId, chatIds));
    eq('re-running the backfill creates no extra threads', threadsAfter.length, threadRows.length);
  } finally {
    await cleanup();
    await pgClient.end({ timeout: 5 }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
