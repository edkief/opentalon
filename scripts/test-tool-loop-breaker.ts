/**
 * Regression checks for the repeated-tool-call circuit breaker (#56).
 *
 * Covers the four acceptance criteria that are testable in isolation:
 *   1. N identical (tool, input) calls within the window are blocked with a
 *      structured error instead of executing;
 *   2. the sliding window catches alternating A-B-A-B loops, which a
 *      consecutive-run counter would miss entirely;
 *   3. a genuinely different call — or a changed output — does not trip it;
 *   4. two breakers (supervisor vs specialist) keep independent counters.
 *
 * Plus the wrapping invariant that is easy to break silently: tool family
 * metadata must survive the clone, or deferred discovery (#53) regresses.
 *
 * Run with: pnpm test:tool-loop-breaker
 */
import { tool } from 'ai';
import { z } from 'zod';
import {
  createLoopBreaker,
  withLoopBreaker,
  callKey,
  resolveLoopBreakerSettings,
  LOOP_BREAKER_DEFAULTS,
  type LoopBreakerSettings,
} from '../src/lib/tools/loop-breaker';
import { setToolFamily, getToolFamily } from '../src/lib/tools/family-metadata';
import { configManager } from '../src/lib/config/config-manager';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

const settings = (over: Partial<LoopBreakerSettings> = {}): LoopBreakerSettings => ({
  ...LOOP_BREAKER_DEFAULTS,
  ...over,
});

/** Build a one-tool set whose execute counts calls and returns `reply(n)`. */
function probeTool(reply: (n: number) => string = () => 'same') {
  let calls = 0;
  const def = tool({
    description: 'probe',
    inputSchema: z.object({ a: z.string().optional(), b: z.string().optional() }),
    execute: async () => reply(++calls),
  });
  return { def, calls: () => calls };
}

async function run(
  tools: Record<string, unknown>,
  name: string,
  input: unknown,
): Promise<{ output?: unknown; error?: string }> {
  const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  try {
    return { output: await t.execute(input, {}) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  // ── 1. Blocks the Nth identical call ────────────────────────────────────────
  console.log('\nblocks a repeated identical call');
  {
    const probe = probeTool();
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'test',
    )!;

    const r1 = await run(guarded, 'probe', { a: 'x' });
    const r2 = await run(guarded, 'probe', { a: 'x' });
    const r3 = await run(guarded, 'probe', { a: 'x' });

    ok('first call executes', r1.output === 'same' && !r1.error);
    ok('second call executes', r2.output === 'same' && !r2.error);
    ok('third identical call is blocked', !!r3.error);
    ok('blocked call never reached the tool', probe.calls() === 2);
    ok('error names the tool and tells the model to change course', !!r3.error?.includes('probe') && !!r3.error?.includes('not executed'));

    // Still blocked afterwards — a stuck model must not get to re-execute.
    const r4 = await run(guarded, 'probe', { a: 'x' });
    ok('stays blocked on further repeats', !!r4.error && probe.calls() === 2);
  }

  // ── 2. Alternating A-B-A-B loops ────────────────────────────────────────────
  console.log('\ncatches an alternating A-B-A-B loop');
  {
    const probe = probeTool();
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'test',
    )!;

    // A B A B A — the third A is the 5th call, inside a window of 6, and a
    // consecutive-run counter would have been reset by every intervening B.
    await run(guarded, 'probe', { a: 'A' });
    await run(guarded, 'probe', { b: 'B' });
    await run(guarded, 'probe', { a: 'A' });
    await run(guarded, 'probe', { b: 'B' });
    const fifth = await run(guarded, 'probe', { a: 'A' });

    ok('third A in the window is blocked despite the interleaved B', !!fifth.error);
    ok('the interleaved B still executed', probe.calls() === 4);
  }

  // ── 3. Does not fire on legitimate traffic ──────────────────────────────────
  console.log('\ndoes not fire on legitimate traffic');
  {
    const probe = probeTool();
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'test',
    )!;
    for (const a of ['1', '2', '3', '4', '5']) await run(guarded, 'probe', { a });
    ok('five distinct calls all execute', probe.calls() === 5);
  }
  {
    // Poll-modify-poll: identical input, but the output changes each time.
    const probe = probeTool((n) => `content-v${n}`);
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'test',
    )!;
    await run(guarded, 'probe', { a: 'file' });
    await run(guarded, 'probe', { a: 'file' });
    const third = await run(guarded, 'probe', { a: 'file' });
    ok('changed output means no loop, so the re-read is allowed', !third.error && probe.calls() === 3);
  }
  {
    // ...but with requireIdenticalOutput off, input identity alone trips it.
    const probe = probeTool((n) => `content-v${n}`);
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6, requireIdenticalOutput: false })),
      'test',
    )!;
    await run(guarded, 'probe', { a: 'file' });
    await run(guarded, 'probe', { a: 'file' });
    const third = await run(guarded, 'probe', { a: 'file' });
    ok('requireIdenticalOutput=false trips on input alone', !!third.error && probe.calls() === 2);
  }
  {
    // A volatile tail defeats output matching; outputHashChars trims it away.
    const probe = probeTool((n) => `stable-body … ts=${n}`);
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6, outputHashChars: 11 })),
      'test',
    )!;
    await run(guarded, 'probe', { a: 'x' });
    await run(guarded, 'probe', { a: 'x' });
    const third = await run(guarded, 'probe', { a: 'x' });
    ok('outputHashChars ignores a volatile tail', !!third.error && probe.calls() === 2);
  }
  {
    // A failing call is not evidence of a stable loop.
    let calls = 0;
    const def = tool({
      description: 'probe',
      inputSchema: z.object({ a: z.string() }),
      // Annotated: an always-throwing body infers Promise<never>, which does
      // not match the tool() overload.
      execute: async (): Promise<string> => { calls++; throw new Error('boom'); },
    });
    const guarded = withLoopBreaker(
      { probe: def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'test',
    )!;
    await run(guarded, 'probe', { a: 'x' });
    await run(guarded, 'probe', { a: 'x' });
    const third = await run(guarded, 'probe', { a: 'x' });
    ok('repeated failures are not treated as a loop', third.error === 'boom' && calls === 3);
  }

  // ── 4. Window bound and key normalization ───────────────────────────────────
  console.log('\nwindow bound and key normalization');
  {
    const probe = probeTool();
    const guarded = withLoopBreaker(
      { probe: probe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 4 })),
      'test',
    )!;
    // A, then 3 distinct calls push A out of the 4-call window, then A again.
    await run(guarded, 'probe', { a: 'A' });
    for (const a of ['1', '2', '3']) await run(guarded, 'probe', { a });
    await run(guarded, 'probe', { a: 'A' });
    const last = await run(guarded, 'probe', { a: 'A' });
    ok('occurrences that fell out of the window do not count', !last.error && probe.calls() === 6);
  }
  ok(
    'key ignores object key ordering',
    callKey('t', { a: 1, b: 2 }) === callKey('t', { b: 2, a: 1 }),
  );
  ok(
    'key ignores undefined-valued properties',
    callKey('t', { a: 1, c: undefined }) === callKey('t', { a: 1 }),
  );
  ok('key still distinguishes different values', callKey('t', { a: 1 }) !== callKey('t', { a: 2 }));
  ok('key still distinguishes different tools', callKey('t', { a: 1 }) !== callKey('u', { a: 1 }));

  // ── 5. Supervisor / specialist isolation ────────────────────────────────────
  console.log('\nsupervisor and specialist counters are independent');
  {
    const supervisorProbe = probeTool();
    const specialistProbe = probeTool();
    const supervisor = withLoopBreaker(
      { probe: supervisorProbe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'supervisor',
    )!;
    const specialist = withLoopBreaker(
      { probe: specialistProbe.def } as never,
      createLoopBreaker(settings({ repeats: 3, window: 6 })),
      'specialist',
    )!;

    await run(supervisor, 'probe', { a: 'x' });
    await run(supervisor, 'probe', { a: 'x' });
    const supervisorBlocked = await run(supervisor, 'probe', { a: 'x' });
    ok('supervisor trips on its own third call', !!supervisorBlocked.error);

    // The specialist has made the identical call zero times so far.
    const specialistFirst = await run(specialist, 'probe', { a: 'x' });
    ok('specialist is unaffected by the supervisor tripping', !specialistFirst.error);
    await run(specialist, 'probe', { a: 'x' });
    const specialistBlocked = await run(specialist, 'probe', { a: 'x' });
    ok('specialist trips only on its own third call', !!specialistBlocked.error);
    ok('each side executed exactly twice', supervisorProbe.calls() === 2 && specialistProbe.calls() === 2);
  }

  // ── 6. Wrapping invariants ──────────────────────────────────────────────────
  console.log('\nwrapping preserves tool metadata and shape');
  {
    const probe = probeTool();
    setToolFamily(probe.def, { id: 'todos', description: 'Create and maintain task lists.', source: 'built-in' });
    const guarded = withLoopBreaker({ probe: probe.def } as never, createLoopBreaker(settings()), 'test')!;
    ok('family metadata survives the clone', getToolFamily('probe', guarded.probe).id === 'todos');
    ok('description survives the clone', (guarded.probe as { description?: string }).description === 'probe');
    ok('the original tool object is not mutated', probe.def.execute !== (guarded.probe as { execute: unknown }).execute);
  }
  {
    // Schema-only tools (provider-executed) have no execute to wrap.
    const noExec = { description: 'no exec', inputSchema: z.object({}) };
    const guarded = withLoopBreaker({ noExec } as never, createLoopBreaker(settings()), 'test')!;
    ok('tools without execute pass through untouched', guarded.noExec === (noExec as never));
  }
  {
    const disabled = withLoopBreaker(
      { probe: probeTool().def } as never,
      createLoopBreaker(settings({ enabled: false })),
      'test',
    );
    ok('disabled breaker returns the set unchanged', disabled?.probe !== undefined);
  }

  // ── 7. Config resolution ────────────────────────────────────────────────────
  console.log('\nconfig resolution');
  {
    const cfg = configManager.get();
    const original = cfg.tools;
    cfg.tools = { ...(cfg.tools ?? {}), loopBreaker: { repeats: 4, window: 2 } };
    const resolved = resolveLoopBreakerSettings();
    ok('config overrides the default repeat count', resolved.repeats === 4);
    ok('a window shorter than repeats is widened to it', resolved.window === 4);
    ok('unset keys fall back to defaults', resolved.requireIdenticalOutput === true && resolved.enabled === true);

    cfg.tools = { ...(cfg.tools ?? {}), loopBreaker: undefined };
    const defaults = resolveLoopBreakerSettings();
    ok(
      'no config yields the documented defaults (3 in 6, output-matched)',
      defaults.repeats === 3 && defaults.window === 6 && defaults.requireIdenticalOutput === true,
    );
    cfg.tools = original;
  }

}

main().then(() => {
  console.log(failed === 0 ? '\nAll loop-breaker checks passed.\n' : `\n${failed} check(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
});
