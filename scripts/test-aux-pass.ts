/**
 * Unit tests for the post-turn auxiliary-pass guard.
 * Covers src/lib/agent/aux-pass.ts.
 *
 * The behaviour under test is the fix for a turn that was lost in production:
 * a 45-step main turn completed on minimax/MiniMax-M3, then the finalise pass —
 * running on a *different* model — failed with ENOTFOUND. Unguarded, that
 * exception escaped the fallback loop, was reported as "Fallback
 * minimax/MiniMax-M3 failed", and discarded the completed turn.
 *
 * Run: pnpm test:aux-pass
 */

import { runAuxPass, type AuxPassFailure } from '../src/lib/agent/aux-pass';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

/** Collects the failures reported for one pass. */
function recorder() {
  const seen: AuxPassFailure[] = [];
  return { seen, onFailure: (f: AuxPassFailure) => { seen.push(f); } };
}

async function main(): Promise<void> {
  console.log('=== Auxiliary pass guard ===\n');

  console.log('a pass that succeeds');
  {
    const rec = recorder();
    const result = await runAuxPass(
      { phase: 'finalise', modelString: 'minimax/MiniMax-M3', onFailure: rec.onFailure },
      async () => 'replacement text',
    );
    eq('returns the value', result, 'replacement text');
    eq('reports no failure', rec.seen.length, 0);
  }

  console.log('\na pass that fails does not sink the turn');
  {
    const rec = recorder();
    const result = await runAuxPass(
      { phase: 'finalise', modelString: 'llama-small/qwen2.5-3b', onFailure: rec.onFailure },
      async () => { throw new Error('Cannot connect to API: getaddrinfo ENOTFOUND llama-qwen25-3b.llama'); },
    );
    eq('swallows the error and returns undefined', result, undefined);
    eq('reports exactly one failure', rec.seen.length, 1);
    eq('attributes it to the model the PASS ran on, not the main turn model',
      rec.seen[0]?.modelString, 'llama-small/qwen2.5-3b');
    eq('tags the phase', rec.seen[0]?.phase, 'finalise');
    eq('carries the provider message',
      rec.seen[0]?.message, 'Cannot connect to API: getaddrinfo ENOTFOUND llama-qwen25-3b.llama');
  }

  console.log('\nnon-Error throws');
  {
    const rec = recorder();
    const result = await runAuxPass(
      { phase: 'todo-check', modelString: 'openai/gpt-4o-mini', onFailure: rec.onFailure },
      async () => { throw 'plain string rejection'; },
    );
    eq('still degrades rather than propagating', result, undefined);
    eq('stringifies the thrown value', rec.seen[0]?.message, 'plain string rejection');
  }

  console.log('\nthe guard is optional-callback safe');
  {
    const result = await runAuxPass(
      { phase: 'summary', modelString: 'openai/gpt-4o-mini' },
      async () => { throw new Error('boom'); },
    );
    eq('no onFailure supplied is not itself an error', result, undefined);
  }

  console.log('\ncancellation is re-thrown, never swallowed');
  {
    // A force /cancel aborts the signal mid-generation. The executor's outer
    // handler converts that into the "⏹ Stopped" reply, so absorbing it here
    // would report a cancelled turn as a completed one.
    const rec = recorder();
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await runAuxPass(
        { phase: 'finalise', modelString: 'minimax/MiniMax-M3', abortSignal: controller.signal, onFailure: rec.onFailure },
        async () => { throw new Error('The operation was aborted'); },
      );
    } catch (err) { thrown = err; }
    eq('rethrows when our own signal is aborted', (thrown as Error)?.message, 'The operation was aborted');
    eq('does not report an aborted pass as a failure', rec.seen.length, 0);
  }

  {
    // Providers wrap aborts inconsistently, so an AbortError is honoured even
    // when we hold no signal of our own.
    const rec = recorder();
    const abortError = new Error('aborted by provider');
    abortError.name = 'AbortError';
    let thrown: unknown;
    try {
      await runAuxPass(
        { phase: 'todo-check', modelString: 'minimax/MiniMax-M3', onFailure: rec.onFailure },
        async () => { throw abortError; },
      );
    } catch (err) { thrown = err; }
    eq('rethrows an AbortError with no signal present', (thrown as Error)?.name, 'AbortError');
    eq('reports no failure', rec.seen.length, 0);
  }

  {
    // An unrelated failure that happens to land while the signal is already
    // aborted is cancellation as far as the turn is concerned — the outer
    // handler owns that outcome.
    const rec = recorder();
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await runAuxPass(
        { phase: 'summary', modelString: 'minimax/MiniMax-M3', abortSignal: controller.signal, onFailure: rec.onFailure },
        async () => { throw new Error('ENOTFOUND something-else'); },
      );
    } catch (err) { thrown = err; }
    eq('an aborted signal wins over the error shape', (thrown as Error)?.message, 'ENOTFOUND something-else');
    eq('reports no failure', rec.seen.length, 0);
  }

  console.log('\na live signal that was never aborted still guards normally');
  {
    const rec = recorder();
    const controller = new AbortController();
    const result = await runAuxPass(
      { phase: 'finalise', modelString: 'llama-small/qwen2.5-3b', abortSignal: controller.signal, onFailure: rec.onFailure },
      async () => { throw new Error('Cannot connect to API'); },
    );
    eq('degrades instead of throwing', result, undefined);
    eq('reports the failure', rec.seen.length, 1);
  }

  console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
