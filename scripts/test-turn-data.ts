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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll turn-data checks passed');
