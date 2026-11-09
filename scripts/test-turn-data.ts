/**
 * Pure checks for turn data storage and replay (epic #80):
 *   #83 — content is made storable for Postgres (NUL bytes, lone surrogates)
 *         and tool-output truncation never splits a surrogate pair;
 *   #85 — replayed tool output from earlier turns is capped per output and
 *         per turn, with call/result pairs kept matched.
 *
 * The database round trip lives in scripts/test-turn-data-db.ts.
 *
 * Run with: pnpm test:turn-data
 */
import { pgSafe, pgSafeText, truncateText } from '../src/lib/db/pg-safe';
import { mapStepToolResults, TOOL_OUTPUT_LIMIT } from '../src/lib/agent/log-bus';
import {
  capReplayedOutputs,
  sanitizeParts,
  toModelMessages,
  REPLAY_OUTPUT_LIMIT,
  REPLAY_TURN_LIMIT,
} from '../src/lib/agent/turn-parts';
import type { ModelMessage } from 'ai';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

const EMOJI = '😀'; // two UTF-16 code units
const HIGH = '\uD83D';
const LOW = '\uDE00';

console.log('#83 pgSafeText');
ok('NUL becomes U+FFFD', pgSafeText('a\0b') === 'a�b');
ok('lone high surrogate becomes U+FFFD', pgSafeText(`x${HIGH}`) === 'x�');
ok('lone low surrogate becomes U+FFFD', pgSafeText(`${LOW}y`) === '�y');
ok('valid emoji, accents and CJK are unchanged', pgSafeText(`é ${EMOJI} 漢字`) === `é ${EMOJI} 漢字`);
ok('length is kept', pgSafeText('a\0\0b').length === 4);

console.log('#83 pgSafe (deep)');
{
  const clean = { a: [`ok ${EMOJI}`, 1, null, true], b: { c: 'ünï' } };
  ok('clean value is returned as the same reference', pgSafe(clean) === clean);

  const dirty = [{ role: 'tool', content: [{ type: 'tool-result', output: { type: 'text', value: 'bin\0ary' } }] }];
  const cleaned = pgSafe(dirty);
  ok('nested NUL is replaced', JSON.stringify(cleaned).includes('bin�ary'));
  ok('input is not mutated', dirty[0].content[0].output.value === 'bin\0ary');
  ok('keys are cleaned', Object.keys(pgSafe({ ['k\0']: 1 }))[0] === 'k�');

  const date = new Date(0);
  ok('non-plain objects pass through', pgSafe({ d: date }).d === date);
  ok('numbers pass through', pgSafe(42) === 42);
  ok('cleaned JSON has no \\u0000 or lone-surrogate escapes', !/\\u0000|\\ud[89ab]/i.test(JSON.stringify(pgSafe([`x${HIGH}`, 'y\0']))));
}

console.log('#83 truncateText');
ok('does not end on a high surrogate', truncateText(`ab${EMOJI}`, 3) === 'ab');
ok('keeps a whole pair that fits', truncateText(`ab${EMOJI}c`, 4) === `ab${EMOJI}`);
ok('short strings are unchanged', truncateText('abc', 10) === 'abc');

console.log('#83 mapStepToolResults at the truncation boundary');
{
  const output = 'a'.repeat(TOOL_OUTPUT_LIMIT - 1) + EMOJI + 'tail';
  const results = mapStepToolResults({ toolResults: [{ toolName: 'run_shell', output }] });
  const out = results?.[0].output ?? '';
  ok('output is well formed', out.isWellFormed());
  ok('output is within the limit', out.length <= TOOL_OUTPUT_LIMIT);
}

console.log('#85 replay cap');
{
  type Out = { type: string; value?: unknown; reason?: string };
  const call = (id: string): ModelMessage => ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'run_shell', input: { command: id } }],
  });
  const result = (id: string, output: Out): ModelMessage =>
    ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'run_shell', output }] }) as ModelMessage;
  const turn = (outputs: Out[]): unknown[] =>
    outputs.flatMap((o, i) => [call(`c${i}`), result(`c${i}`, o)]);
  const outputsOf = (msgs: ModelMessage[]): Out[] =>
    msgs.flatMap((m) => (m.role === 'tool' ? m.content.map((p) => (p as { output: Out }).output) : []));
  const textOf = (o: Out) => String(o.value ?? '');

  const short = turn([{ type: 'text', value: 'ok' }, { type: 'json', value: { a: 1 } }, { type: 'execution-denied', reason: 'no' }]);
  const shortReplay = toModelMessages({ role: 'assistant', content: 'done', parts: short });
  ok('short turn replays exactly as before', JSON.stringify(shortReplay) === JSON.stringify([...sanitizeParts(short), { role: 'assistant', content: 'done' }]));
  const shortSanitized = sanitizeParts(short);
  ok('short turn is returned as the same array', capReplayedOutputs(shortSanitized) === shortSanitized);

  const long = 'x'.repeat(REPLAY_OUTPUT_LIMIT * 3);
  const [cut] = outputsOf(capReplayedOutputs(sanitizeParts(turn([{ type: 'text', value: long }]))));
  ok('a long output is cut to the per-output limit', textOf(cut).startsWith('x'.repeat(REPLAY_OUTPUT_LIMIT) + '\n'));
  ok('…and says so', textOf(cut).includes(`cut for replay: showing ${REPLAY_OUTPUT_LIMIT} of ${long.length} chars`));
  ok('…keeping its type', cut.type === 'text');

  const [errCut] = outputsOf(capReplayedOutputs(sanitizeParts(turn([{ type: 'error-json', value: { trace: long } }]))));
  ok('a long json error becomes cut error-text', errCut.type === 'error-text' && textOf(errCut).includes('cut for replay'));

  const [contentCut] = outputsOf(capReplayedOutputs(sanitizeParts(turn([{
    type: 'content',
    value: [{ type: 'text', text: long }, { type: 'image-data', data: 'AAAA', mediaType: 'image/png' }],
  }]))));
  ok('a long content output becomes text with media counted', contentCut.type === 'text' &&
    textOf(contentCut).startsWith('[1 media part omitted]\n') && textOf(contentCut).includes('cut for replay'));

  const emojiBoundary = 'a'.repeat(REPLAY_OUTPUT_LIMIT - 1) + EMOJI.repeat(REPLAY_OUTPUT_LIMIT);
  const [emojiCut] = outputsOf(capReplayedOutputs(sanitizeParts(turn([{ type: 'text', value: emojiBoundary }]))));
  ok('a cut never splits an emoji', textOf(emojiCut).isWellFormed());

  // A 200-step run: far more output than the turn budget.
  const n = 60;
  const big = turn(Array.from({ length: n }, (_, i) => ({ type: 'text', value: `#${i} ` + 'y'.repeat(5_000) })));
  const capped = capReplayedOutputs(sanitizeParts(big));
  const outs = outputsOf(capped);
  const replayed = outs.reduce((sum, o) => sum + textOf(o).length, 0);
  ok('turn total stays near the per-turn limit', replayed < REPLAY_TURN_LIMIT + n * 120);
  ok('the newest output keeps its budget', textOf(outs[n - 1]).startsWith(`#${n - 1} `) && textOf(outs[n - 1]).includes('cut for replay'));
  ok('the oldest output is reduced to a stub', /^\[output omitted from replay: \d+ chars\]$/.test(textOf(outs[0])));
  const ids = (role: string) => capped.filter((m) => m.role === role)
    .flatMap((m) => (m.content as Array<{ toolCallId?: string }>).map((p) => p.toolCallId)).join();
  ok('every call still has its result', ids('assistant') === ids('tool') && sanitizeParts(capped).length === capped.length);
  ok('stored parts are not mutated', textOf(outputsOf(big as ModelMessage[])[0]).length === `#0 `.length + 5_000);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll turn-data checks passed');
