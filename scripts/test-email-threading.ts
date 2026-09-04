/**
 * Unit tests for the pure email threading logic (src/lib/email/threading.ts).
 *
 * These cover id normalization, root-id selection (reply chains, References-only,
 * mid-thread), deterministic chatId derivation, subject normalization + reply
 * detection (subject change → new thread), reply-subject building, and
 * References capping. The DB-backed paths (findChatIdByMessageIds, subject
 * fallback, UIDVALIDITY reset) are exercised by the Phase 7 e2e suite, which
 * needs a live Postgres/mailbox.
 *
 * Run: pnpm test:email-threading
 */

import {
  normalizeMessageId,
  normalizeIds,
  referencedIds,
  rootMessageId,
  threadIdFromSeed,
  normalizeSubject,
  subjectIsReply,
  buildReplySubject,
  capReferences,
} from '../src/lib/email/threading';

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

console.log('=== Email Threading (pure) ===\n');

console.log('id normalization');
eq('strips angle brackets', normalizeMessageId('<abc@x.com>'), 'abc@x.com');
eq('trims whitespace', normalizeMessageId('  <abc@x.com>  '), 'abc@x.com');
eq('handles missing', normalizeMessageId(undefined), '');
eq('handles bare id', normalizeMessageId('abc@x.com'), 'abc@x.com');
eq('normalizeIds dedups + drops empty', normalizeIds(['<a@x>', 'a@x', undefined, '<b@x>']), ['a@x', 'b@x']);

console.log('\nreferenced ids (In-Reply-To + References)');
eq(
  'combines in-reply-to first then references, deduped',
  referencedIds('<c@x>', ['<a@x>', '<b@x>', '<c@x>']),
  ['c@x', 'a@x', 'b@x'],
);
eq('empty when none', referencedIds(null, null), []);

console.log('\nroot message id');
eq('References[0] is root (RFC oldest-first)', rootMessageId('<self@x>', '<b@x>', ['<a@x>', '<b@x>']), 'a@x');
eq('falls back to In-Reply-To when no References', rootMessageId('<self@x>', '<b@x>', []), 'b@x');
eq('falls back to own id when no header links', rootMessageId('<self@x>', null, null), 'self@x');

console.log('\ndeterministic chatId derivation');
const cidA = threadIdFromSeed('root@x.com');
eq('email: prefix + 16 hex', /^email:[0-9a-f]{16}$/.test(cidA), true);
eq('stable across calls', threadIdFromSeed('root@x.com'), cidA);
eq('normalization-insensitive (brackets)', threadIdFromSeed('<root@x.com>'), cidA);
ok('different roots → different chatIds', threadIdFromSeed('other@x.com') !== cidA);

console.log('\nreply chain resolves to same root chatId');
// Original message self id, first reply references it, second reply references both.
const origId = 'msg1@x.com';
const rootFromReply1 = rootMessageId('reply1@x.com', origId, [origId]);
const rootFromReply2 = rootMessageId('reply2@x.com', 'reply1@x.com', [origId, 'reply1@x.com']);
eq('reply1 root == orig', threadIdFromSeed(rootFromReply1), threadIdFromSeed(origId));
eq('reply2 root == orig (mid-thread References-only)', threadIdFromSeed(rootFromReply2), threadIdFromSeed(origId));

console.log('\nsubject normalization + reply detection');
eq('strips Re:', normalizeSubject('Re: Hello World'), 'hello world');
eq('strips stacked Re: Fwd:', normalizeSubject('Re: Fwd: Hello'), 'hello');
eq('strips Fw:', normalizeSubject('Fw: Status'), 'status');
eq('collapses whitespace', normalizeSubject('Re:   Big    Deal '), 'big deal');
eq('localized AW: (German)', normalizeSubject('AW: Rechnung'), 'rechnung');
ok('Re: subject is reply', subjectIsReply('Re: Hello'));
ok('Fwd: subject is reply', subjectIsReply('Fwd: Hello'));
ok('fresh subject is NOT reply', !subjectIsReply('Hello'));
// subject change → new thread: a fresh (non-Re:) subject has no reply marker,
// so the resolver mints a new chatId from the message's own id.
ok('fresh subject not treated as reply', !subjectIsReply('Brand New Topic'));

console.log('\nreply-subject building (no Re: stacking)');
eq('adds Re:', buildReplySubject('Hello'), 'Re: Hello');
eq('does not stack Re: Re:', buildReplySubject('Re: Hello'), 'Re: Hello');
eq('collapses stacked prefixes to single Re:', buildReplySubject('Re: Fwd: Hello'), 'Re: Hello');
eq('empty subject', buildReplySubject(''), 'Re:');

console.log('\nreferences capping');
const many = Array.from({ length: 40 }, (_, i) => `id${i}@x`);
const capped = capReferences(many, 30);
eq('capped length', capped.length, 30);
eq('keeps root first', capped[0], 'id0@x');
eq('keeps most recent last', capped[capped.length - 1], 'id39@x');
eq('short chain unchanged', capReferences(['a@x', 'b@x'], 30), ['a@x', 'b@x']);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
