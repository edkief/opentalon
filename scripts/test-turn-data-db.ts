/**
 * Database round trip for turn data writes (epic #80):
 *   #83 — rows and steps holding NUL bytes or split surrogates are stored;
 *         ordinary text round-trips unchanged.
 *
 * Drives the real `addMessage` and `persistStepEvent` against a live Postgres
 * carrying the current schema:
 *   pnpm deps:up && pnpm db:push && pnpm test:turn-data-db
 * Skips (exit 0) when DATABASE_URL is unset or unreachable. Fixture rows are
 * deleted at the end.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
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

const EMOJI = '😀';
/** JSON with sorted keys — jsonb does not keep key order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x);
const toolParts = (output: string) => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'run_shell', input: { command: 'cat x' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'run_shell', output: { type: 'text', value: output } }] },
];

async function main(): Promise<void> {
  console.log('=== Turn data writes (#83) ===\n');

  if (!(await reachable())) {
    console.log('  ⊘ skipped: DATABASE_URL unset or Postgres unreachable');
    console.log('    start services with `pnpm deps:up && pnpm db:push`');
    process.exit(0);
  }

  const { db, pgClient } = await import('../src/lib/db');
  const { conversations, conversationSteps } = await import('../src/lib/db/schema');
  const { addMessage } = await import('../src/lib/db/conversation');
  const { persistStepEvent } = await import('../src/lib/agent/orchestration-store');
  const { eq } = await import('drizzle-orm');

  const chatId = `test-turn-data-${randomUUID()}`;
  const rowFor = async (turnId: string) =>
    (await db.select().from(conversations).where(eq(conversations.turnId, turnId)))[0];

  try {
    // Baseline: the raw insert really is rejected, so the checks below mean something.
    let rawRejected = false;
    try {
      await db.insert(conversations).values({
        chatId, threadId: chatId, messageId: 0, role: 'assistant', content: 'x', agentId: 'test',
        turnId: randomUUID(), parts: toolParts('bin\0ary'),
      });
    } catch {
      rawRejected = true;
    }
    ok('baseline: Postgres rejects an unsanitised NUL in parts', rawRejected);

    console.log('#83 conversations');
    const nulTurn = randomUUID();
    await addMessage(chatId, chatId, 0, 'assistant', 'reply\0text', 'test', { model: 'm' }, nulTurn, toolParts('bin\0ary'));
    const nulRow = await rowFor(nulTurn);
    ok('row whose parts hold a NUL byte is stored', !!nulRow);
    ok('…with its parts', JSON.stringify(nulRow?.parts ?? null).includes('bin�ary'));
    ok('…and its content', nulRow?.content === 'reply�text');

    const surrogateTurn = randomUUID();
    await addMessage(chatId, chatId, 0, 'assistant', 'ok', 'test', undefined, surrogateTurn, toolParts(`half \uD83D`));
    const surrogateRow = await rowFor(surrogateTurn);
    ok('row whose parts hold an unpaired surrogate is stored', !!surrogateRow?.parts);

    const plainTurn = randomUUID();
    const plain = `Café ${EMOJI} 漢字 — "quotes"\n\ttabs`;
    await addMessage(chatId, chatId, 0, 'assistant', plain, 'test', undefined, plainTurn, toolParts(plain));
    const plainRow = await rowFor(plainTurn);
    ok('ordinary text is stored unchanged (content)', plainRow?.content === plain);
    ok('ordinary text is stored unchanged (parts)', canon(plainRow?.parts) === canon(toolParts(plain)));

    console.log('#83 conversation_steps');
    const stepTurn = randomUUID();
    // What a `.slice` at the limit used to produce: the first half of an emoji.
    await persistStepEvent({
      id: randomUUID(), sessionId: chatId, timestamp: new Date().toISOString(), stepIndex: 1, finishReason: 'tool-calls',
      turnId: stepTurn, agentId: 'test', text: 'step\0text',
      toolResults: [{ toolName: 'run_shell', output: `cut ${EMOJI.slice(0, 1)}` }],
    });
    const steps = await db.select().from(conversationSteps).where(eq(conversationSteps.turnId, stepTurn));
    ok('step with a split emoji and a NUL is stored', steps.length === 1);
  } finally {
    await db.delete(conversations).where(eq(conversations.chatId, chatId));
    await db.delete(conversationSteps).where(eq(conversationSteps.chatId, chatId));
    await pgClient.end({ timeout: 1 });
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll turn-data DB checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
