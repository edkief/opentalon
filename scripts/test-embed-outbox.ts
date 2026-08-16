/**
 * DB-backed tests for the embed channel's thread and outbox layer
 * (src/lib/db/embed.ts): thread upsert semantics, inbound idempotency, and the
 * sequence guarantees the client cursor depends on.
 *
 * Needs a live Postgres with the migrations applied:
 *   pnpm deps:up && pnpm db:push && pnpm test:embed-outbox
 * Skips (exit 0) when DATABASE_URL is unset or unreachable, so it is safe in a
 * checkout without services running.
 *
 * All rows are written under a unique chatId prefix and deleted at the end.
 */

import postgres from 'postgres';
import { and, eq, like } from 'drizzle-orm';

let passed = 0;
let failed = 0;

function eq_(name: string, actual: unknown, expected: unknown): void {
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
  eq_(name, cond, true);
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

async function main(): Promise<void> {
  if (!(await reachable())) {
    console.log('=== Embed outbox ===\n');
    console.log('  ⊘ skipped: DATABASE_URL unset or Postgres unreachable');
    console.log('    start services with `pnpm deps:up && pnpm db:push`');
    process.exit(0);
  }

  const { db } = await import('../src/lib/db');
  const { embedInbound, embedOutbox, embedThreads } = await import('../src/lib/db/schema');
  const {
    claimEmbedInbound,
    getEmbedChatTitle,
    getEmbedThread,
    latestEmbedOutboxSeq,
    pushEmbedOutbox,
    readEmbedOutbox,
    sweepEmbedOutbox,
    updateEmbedThreadContext,
    upsertEmbedThread,
  } = await import('../src/lib/db/embed');

  const run = Date.now().toString(36);
  const chat = `embed:test-${run}:aaaaaaaaaaaaaaaa`;
  const chat2 = `embed:test-${run}:bbbbbbbbbbbbbbbb`;

  const cleanup = async () => {
    for (const id of [chat, chat2]) {
      await db.delete(embedOutbox).where(eq(embedOutbox.chatId, id));
      await db.delete(embedInbound).where(eq(embedInbound.chatId, id));
      await db.delete(embedThreads).where(eq(embedThreads.chatId, id));
    }
  };

  console.log('=== Embed outbox ===\n');

  try {
    await cleanup();

    // ── Threads ──────────────────────────────────────────────────────────────
    console.log('threads');
    await upsertEmbedThread({
      chatId: chat,
      clientId: 'test',
      resourceId: 'demo-abc123',
      userKey: 'user-1',
      userLabel: 'Ed',
      title: 'Widget Handbook',
      url: 'https://example.com/pub/demo-abc123/',
      context: { summary: 'first' },
      contextVersion: 'v1',
    });
    {
      const t = await getEmbedThread(chat);
      eq_('creates the thread', t?.resourceId, 'demo-abc123');
      eq_('stores the context', t?.contextVersion, 'v1');
      eq_('starts at seq 0', t?.lastSeq, 0);
    }

    // A message POST with no envelope must not wipe context set earlier.
    await upsertEmbedThread({
      chatId: chat,
      clientId: 'test',
      resourceId: 'demo-abc123',
      userKey: 'user-1',
      title: 'Widget Handbook v2',
    });
    {
      const t = await getEmbedThread(chat);
      eq_('refreshes the title', t?.title, 'Widget Handbook v2');
      eq_('preserves context when none is supplied', t?.contextVersion, 'v1');
    }

    await upsertEmbedThread({
      chatId: chat,
      clientId: 'test',
      resourceId: 'demo-abc123',
      userKey: 'user-1',
      title: 'Widget Handbook v2',
      context: { summary: 'second' },
      contextVersion: 'v2',
    });
    eq_('overwrites context when supplied', (await getEmbedThread(chat))?.contextVersion, 'v2');

    await updateEmbedThreadContext(chat, { summary: 'third' }, 'v3');
    eq_('dedicated context update applies', (await getEmbedThread(chat))?.contextVersion, 'v3');

    eq_('title resolves for the chats list', await getEmbedChatTitle(chat), 'Widget Handbook v2');

    // ── Inbound idempotency ──────────────────────────────────────────────────
    console.log('\ninbound idempotency');
    {
      const first = await claimEmbedInbound(chat, 'msg-1', 'turn-A');
      ok('first claim is fresh', first.fresh);
      const retry = await claimEmbedInbound(chat, 'msg-1', 'turn-B');
      eq_('retry is not fresh', retry.fresh, false);
      eq_('retry returns the original turn', retry.turnId, 'turn-A');
      const other = await claimEmbedInbound(chat, 'msg-2', 'turn-C');
      ok('a different message id is fresh', other.fresh);
      const otherChat = await claimEmbedInbound(chat2, 'msg-1', 'turn-D');
      ok('same message id on another chat is fresh', otherChat.fresh);
    }

    // ── Outbox sequencing ────────────────────────────────────────────────────
    console.log('\noutbox sequencing');
    eq_('cursor starts at 0', await latestEmbedOutboxSeq(chat), 0);
    eq_('first push is seq 1', await pushEmbedOutbox(chat, { content: 'one' }), 1);
    eq_('second push is seq 2', await pushEmbedOutbox(chat, { content: 'two' }), 2);
    eq_('cursor tracks the last push', await latestEmbedOutboxSeq(chat), 2);

    {
      // Concurrent pushes model an agent reply landing at the same moment as an
      // out-of-band push (a scheduled task firing). Sequences must stay unique
      // and gapless or a client cursor silently skips a message.
      const seqs = await Promise.all(
        Array.from({ length: 20 }, (_, i) => pushEmbedOutbox(chat, { content: `c${i}` })),
      );
      const sorted = [...seqs].sort((a, b) => a - b);
      eq_('concurrent pushes are unique', new Set(seqs).size, 20);
      eq_('concurrent pushes are gapless', sorted, Array.from({ length: 20 }, (_, i) => i + 3));
    }

    eq_('per-chat sequences are independent', await pushEmbedOutbox(chat2, { content: 'other' }), 1);

    {
      const rows = await readEmbedOutbox(chat, 0, 500);
      eq_('reads everything from cursor 0', rows.length, 22);
      eq_('returns rows in order', rows[0].seq, 1);
      const tail = await readEmbedOutbox(chat, 20, 500);
      eq_('reads only rows past the cursor', tail.map((r) => r.seq), [21, 22]);
      eq_('cursor at the end returns nothing', (await readEmbedOutbox(chat, 22, 500)).length, 0);
      eq_('does not leak another chat', (await readEmbedOutbox(chat2, 0, 500)).length, 1);
    }

    eq_('pushing to a chat with no thread is a no-op', await pushEmbedOutbox(`${chat}-missing`, { content: 'x' }), 0);

    {
      const seq = await pushEmbedOutbox(chat, { content: 'notice', kind: 'notice', role: 'system', format: 'html' });
      const [row] = await readEmbedOutbox(chat, seq - 1, 1);
      eq_('records kind', row.kind, 'notice');
      eq_('records role', row.role, 'system');
      eq_('records format', row.format, 'html');
    }

    // ── Retention ────────────────────────────────────────────────────────────
    console.log('\nretention');
    {
      const before = await latestEmbedOutboxSeq(chat);
      // Age every row for this chat past the window.
      await db
        .update(embedOutbox)
        .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
        .where(eq(embedOutbox.chatId, chat));
      const swept = await sweepEmbedOutbox(24);
      ok('sweeps aged rows', swept >= before);
      eq_('outbox is empty after the sweep', (await readEmbedOutbox(chat, 0, 500)).length, 0);
      // The whole point of keeping lastSeq on the thread: a swept chat must not
      // restart numbering under a client that still holds an old cursor.
      eq_('cursor survives the sweep', await latestEmbedOutboxSeq(chat), before);
      eq_('next push continues above the old cursor', await pushEmbedOutbox(chat, { content: 'after' }), before + 1);
    }

    // Guard against a stray test row escaping cleanup.
    const strays = await db
      .select({ chatId: embedThreads.chatId })
      .from(embedThreads)
      .where(and(like(embedThreads.chatId, `embed:test-${run}:%`)));
    eq_('only the two test threads exist', strays.length, 2);
  } finally {
    await cleanup();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
