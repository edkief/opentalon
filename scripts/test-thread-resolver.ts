/**
 * Unit tests for the thread resolution seam (src/lib/threads/) and the golden
 * id-parity guarantee for the channels that were renamed in #44.
 *
 * The store (ensureThread/getThread/...) is not covered here — it is pure DB
 * I/O and needs a live Postgres; the backfill parity suite
 * (pnpm test:thread-backfill) covers the thread table itself.
 *
 * Run: pnpm test:thread-resolver
 */

import type { Chat, Message } from 'grammy/types';
import { telegramThread } from '../src/lib/threads/telegram';
import { webThread } from '../src/lib/threads/web';
import { DEFAULT_THREAD_ID } from '../src/lib/threads/types';
import { threadIdFromSeed, chatIdFromSeed, rootMessageId } from '../src/lib/email/threading';
import { embedThreadId, embedChatId } from '../src/lib/embed/threads';

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

// ─── Telegram ────────────────────────────────────────────────────────────────
// Every message resolves to its chat's root thread until #46 reads
// message_thread_id; that is what keeps this ticket's "no user-visible change".

console.log('\ntelegram resolver');
{
  const dm = { id: 12345, type: 'private' } as Chat;
  const r = telegramThread(dm);
  eq('DM threadId === chatId', r.threadId, '12345');
  eq('DM chatId', r.chatId, '12345');
  eq('DM channel', r.channel, 'telegram');

  const group = { id: -1001234567890, type: 'supergroup' } as Chat;
  const g = telegramThread(group);
  eq('group threadId === chatId', g.threadId, '-1001234567890');
  ok('negative chat id survives verbatim', g.threadId === g.chatId);

  // A forum message carries message_thread_id; T3 must still collapse it onto
  // the root thread, otherwise topic threads would appear before any outbound
  // path echoes the topic id back (#46).
  const topicMsg = { message_thread_id: 42 } as Message;
  eq('forum topic still resolves to root in T3', telegramThread(group, topicMsg).threadId, '-1001234567890');

  ok('no route until #46', telegramThread(group, topicMsg).route === undefined);
}

// ─── Web ─────────────────────────────────────────────────────────────────────
// The epic assumed one hardcoded 'web' conversation; api/chat already accepts a
// chatId from the body, so the fallback is the chatId, not the literal.

console.log('\nweb resolver');
{
  eq('explicit threadId wins', webThread('web:abc', 'chat-1').threadId, 'web:abc');
  eq('explicit threadId keeps its chatId for routing', webThread('web:abc', 'chat-1').chatId, 'chat-1');
  eq('falls back to the request chatId', webThread(undefined, 'chat-1').threadId, 'chat-1');
  eq('neither supplied → historical web id', webThread().threadId, 'web');
  eq('neither supplied → historical chat id', webThread().chatId, 'web');
  eq('blank strings are not ids', webThread('  ', '  ').threadId, 'web');
  eq('null threadId falls back', webThread(null, 'chat-2').threadId, 'chat-2');
  eq('channel', webThread().channel, 'web');
}

// ─── Golden id parity (the ticket's key criterion) ───────────────────────────
// #44 renamed the email and embed resolvers. The ids are persisted in
// email_messages and conversations and are the join key for every existing
// thread, so a change in derivation would silently orphan live conversations.
// These vectors pin the literal output, so a future edit to the seed format
// fails loudly here rather than in production.

console.log('\ngolden id parity (email)');
{
  eq('email root seed', threadIdFromSeed('root@x.com'), 'email:0164c6a533373511');
  eq('email bracket-normalized seed', threadIdFromSeed('<root@x.com>'), 'email:0164c6a533373511');
  eq('email distinct seed', threadIdFromSeed('orig@x.com'), 'email:4662e2a843177ab3');
  ok('email prefix preserved', threadIdFromSeed('any@x.com').startsWith('email:'));
  eq('email hash width unchanged (16 hex)', threadIdFromSeed('any@x.com').slice('email:'.length).length, 16);

  // A reply chain must land on the same thread as the message it answers.
  const origId = 'orig@x.com';
  const root = rootMessageId('reply@x.com', origId, null);
  eq('reply resolves onto the original thread', threadIdFromSeed(root), threadIdFromSeed(origId));

  eq('deprecated alias is the same function', chatIdFromSeed('root@x.com'), threadIdFromSeed('root@x.com'));
}

console.log('\ngolden id parity (embed)');
{
  eq('embed user-1', embedThreadId('talonpress', 'demo-abc123', 'user-1'), 'embed:talonpress:4266655921048e8b');
  eq('embed user-2', embedThreadId('talonpress', 'demo-abc123', 'user-2'), 'embed:talonpress:f361d6170b8edd33');
  ok(
    'embed distinguishes resource',
    embedThreadId('talonpress', 'other', 'user-1') !== embedThreadId('talonpress', 'demo-abc123', 'user-1'),
  );
  ok(
    'embed distinguishes client',
    embedThreadId('other', 'demo-abc123', 'user-1') !== embedThreadId('talonpress', 'demo-abc123', 'user-1'),
  );
  eq('embed client id stays readable in the prefix', embedThreadId('talonpress', 'r', 'u').split(':')[1], 'talonpress');
  eq(
    'deprecated alias is the same function',
    embedChatId('talonpress', 'demo-abc123', 'user-1'),
    embedThreadId('talonpress', 'demo-abc123', 'user-1'),
  );
}

// ─── Root-thread invariant ───────────────────────────────────────────────────
// The epic's hard rule: routing reads threads.chat_id, never the threadId
// string. Email and embed ids serve as both, so they must stay equal.

console.log('\nroot-thread invariant');
{
  eq('DEFAULT_THREAD_ID is reserved and not a per-chat fallback', DEFAULT_THREAD_ID, 'default');
  ok('telegram root thread id equals its chat id', telegramThread({ id: 7, type: 'private' } as Chat).threadId === '7');

  // Anything the #43 backfill suffixed is not a routable chat id — a reminder
  // encoded as a test so #46's sendToThread has something to point at.
  const archived = '12345#assistant';
  ok('backfilled non-primary thread ids are not numeric chat ids', !/^-?\d+$/.test(archived));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
