/**
 * Unit tests for the process-wide turn queue.
 * Covers src/lib/concurrency/turn-queue.ts.
 * Run: pnpm test:turn-queue
 */

import {
  enqueueForTurn,
  hasQueuedTurn,
  serializationKey,
  toTurnKey,
  turnKeyOf,
  __setSerializationKeyForTest,
} from '../src/lib/concurrency/turn-queue';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves once every queued chain has drained. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await sleep(2);
}

async function main(): Promise<void> {
  console.log('=== Turn queue ===\n');

  console.log('key derivation');
  eq('a bare chatId names that chat\'s root thread',
    toTurnKey('123'), { threadId: '123', chatId: '123' });
  eq('a full key passes through',
    toTurnKey({ threadId: '123:t7', chatId: '123' }), { threadId: '123:t7', chatId: '123' });
  eq('serialization is per chat by default',
    serializationKey({ threadId: '123:t7', chatId: '123' }), '123');
  eq('two threads on one chat share a key today',
    turnKeyOf({ threadId: '123:t7', chatId: '123' }), turnKeyOf({ threadId: '123:t9', chatId: '123' }));

  console.log('\nsame chat: turns serialize');
  {
    const log: string[] = [];
    const task = (id: string, ms: number) => async () => {
      log.push(`${id}:start`);
      await sleep(ms);
      log.push(`${id}:end`);
    };
    // B is deliberately faster than A: without a queue it would finish first.
    enqueueForTurn('chat-a', task('A', 40));
    enqueueForTurn('chat-a', task('B', 5));
    await settle();
    eq('no interleaving', log, ['A:start', 'A:end', 'B:start', 'B:end']);
  }

  console.log('\ndifferent chats: turns run in parallel');
  {
    const log: string[] = [];
    const task = (id: string) => async () => {
      log.push(`${id}:start`);
      await sleep(20);
      log.push(`${id}:end`);
    };
    enqueueForTurn('chat-x', task('X'));
    enqueueForTurn('chat-y', task('Y'));
    await settle();
    eq('both start before either finishes', log, ['X:start', 'Y:start', 'X:end', 'Y:end']);
  }

  console.log('\na failing turn does not stall the ones behind it');
  {
    const log: string[] = [];
    enqueueForTurn('chat-f', async () => { throw new Error('boom (expected — logged above)'); });
    enqueueForTurn('chat-f', async () => { log.push('after'); });
    await settle();
    eq('the next turn still runs', log, ['after']);
  }

  console.log('\nidle conversations do not leak map entries');
  {
    enqueueForTurn('chat-leak', async () => { await sleep(5); });
    eq('tracked while in flight', hasQueuedTurn('chat-leak'), true);
    await settle();
    eq('dropped once drained', hasQueuedTurn('chat-leak'), false);
  }

  console.log('\nper-thread flip: threads in one chat run in parallel');
  {
    const restore = __setSerializationKeyForTest((k) => k.threadId);
    try {
      eq('the flip splits the key', turnKeyOf({ threadId: '55:t1', chatId: '55' }), '55:t1');

      const log: string[] = [];
      const task = (id: string) => async () => {
        log.push(`${id}:start`);
        await sleep(20);
        log.push(`${id}:end`);
      };
      enqueueForTurn({ threadId: '55:t1', chatId: '55' }, task('T1'));
      enqueueForTurn({ threadId: '55:t2', chatId: '55' }, task('T2'));
      await settle();
      eq('two threads on one chat overlap', log, ['T1:start', 'T2:start', 'T1:end', 'T2:end']);

      // Same thread still serializes under the flip.
      const same: string[] = [];
      enqueueForTurn({ threadId: '55:t1', chatId: '55' }, async () => { same.push('a:start'); await sleep(20); same.push('a:end'); });
      enqueueForTurn({ threadId: '55:t1', chatId: '55' }, async () => { same.push('b:start'); same.push('b:end'); });
      await settle();
      eq('one thread still serializes', same, ['a:start', 'a:end', 'b:start', 'b:end']);
    } finally {
      restore();
    }
    eq('restored to per-chat', turnKeyOf({ threadId: '55:t1', chatId: '55' }), '55');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
