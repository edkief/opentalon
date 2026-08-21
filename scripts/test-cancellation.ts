/**
 * Unit tests for the turn cancellation registry behind /cancel.
 * Covers src/lib/agent/cancellation.ts.
 * Run: pnpm test:cancellation
 */

import { turnCancellation, cancellationRegistry } from '../src/lib/agent/cancellation';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

console.log('=== Turn cancellation ===\n');

console.log('no turn running');
eq('request on an idle chat reports nothing to cancel',
  turnCancellation.request('idle-chat'), { status: 'none' });
eq('isRunning false', turnCancellation.isRunning('idle-chat'), false);

console.log('\ngraceful stop');
{
  const t = turnCancellation.register('chat-a', 'turn-1');
  eq('shouldStop false before any request', t.shouldStop(), false);
  eq('signal not aborted before any request', t.signal.aborted, false);
  eq('request returns graceful', turnCancellation.request('chat-a'), { status: 'graceful' });
  eq('shouldStop true after request', t.shouldStop(), true);
  eq('graceful does NOT abort the signal', t.signal.aborted, false);
  eq('requested reports graceful', turnCancellation.requested('chat-a'), 'graceful');
  turnCancellation.unregister('chat-a', 'turn-1');
}

console.log('\nescalation: a second /cancel forces');
{
  const t = turnCancellation.register('chat-b', 'turn-1');
  turnCancellation.request('chat-b');
  eq('second request escalates to force',
    turnCancellation.request('chat-b'), { status: 'force', escalated: true });
  eq('signal aborted', t.signal.aborted, true);
  eq('shouldStop false once escalated (signal carries it now)', t.shouldStop(), false);
  turnCancellation.unregister('chat-b', 'turn-1');
}

console.log('\nexplicit force');
{
  const t = turnCancellation.register('chat-c', 'turn-1');
  eq('force from a clean state is not an escalation',
    turnCancellation.request('chat-c', 'force'), { status: 'force', escalated: false });
  eq('signal aborted immediately', t.signal.aborted, true);
  turnCancellation.unregister('chat-c', 'turn-1');
}

console.log('\nforce cascades into the turn\'s specialists');
{
  const jobIds = new Set<string>();
  const t = turnCancellation.register('chat-d', 'turn-1', jobIds);
  const specA = cancellationRegistry.register('spec-a');
  const specB = cancellationRegistry.register('spec-b');
  jobIds.add('spec-a');
  jobIds.add('spec-b');
  turnCancellation.request('chat-d', 'force');
  eq('turn signal aborted', t.signal.aborted, true);
  eq('specialist a aborted', specA.signal.aborted, true);
  eq('specialist b aborted', specB.signal.aborted, true);
  cancellationRegistry.unregister('spec-a');
  cancellationRegistry.unregister('spec-b');
  turnCancellation.unregister('chat-d', 'turn-1');
}

console.log('\ngraceful leaves specialists alone');
{
  const jobIds = new Set<string>(['spec-c']);
  const spec = cancellationRegistry.register('spec-c');
  turnCancellation.register('chat-e', 'turn-1', jobIds);
  turnCancellation.request('chat-e');
  eq('specialist not aborted', spec.signal.aborted, false);
  cancellationRegistry.unregister('spec-c');
  turnCancellation.unregister('chat-e', 'turn-1');
}

console.log('\nunregister is turn-scoped');
{
  turnCancellation.register('chat-f', 'turn-1');
  // A stale unregister from a turn that already lost the slot must not clear
  // the newer turn the user is actually watching.
  turnCancellation.register('chat-f', 'turn-2');
  turnCancellation.unregister('chat-f', 'turn-1');
  eq('newer turn survives a stale unregister', turnCancellation.isRunning('chat-f'), true);
  turnCancellation.unregister('chat-f', 'turn-2');
  eq('matching unregister clears it', turnCancellation.isRunning('chat-f'), false);
}

console.log('\nre-registering the same chat replaces the stale entry');
{
  const first = turnCancellation.register('chat-g', 'turn-1');
  const second = turnCancellation.register('chat-g', 'turn-2');
  turnCancellation.request('chat-g', 'force');
  eq('newest turn is the one cancelled', second.signal.aborted, true);
  eq('stale turn untouched', first.signal.aborted, false);
  turnCancellation.unregister('chat-g', 'turn-2');
}

console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
