/**
 * Unit tests for request_guidance option handling (#40).
 * Covers src/lib/guidance-options.ts and the request_guidance input schema.
 * Run: pnpm test:guidance-options
 */

import { z } from 'zod';
import {
  normalizeGuidanceOptions,
  guidanceOptionsFromRow,
  formatGuidanceOptionList,
  buttonText,
  TELEGRAM_BUTTON_TEXT_LIMIT,
} from '../src/lib/guidance-options';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

console.log('=== Guidance Options ===\n');

const objectOptions = [
  { label: 'rsync', description: 'Use rsync over SSH — simple, no dedup' },
  { label: 'restic', description: 'Use restic to a remote repo — encrypted, deduped' },
];

console.log('normalizeGuidanceOptions');
eq('string[] shortcut uses the string for both fields',
  normalizeGuidanceOptions(['Yes', 'No']),
  [{ label: 'Yes', description: 'Yes' }, { label: 'No', description: 'No' }]);
eq('{label, description} passes through', normalizeGuidanceOptions(objectOptions), objectOptions);
eq('mixed shapes normalize together',
  normalizeGuidanceOptions(['Cancel', { label: 'restic', description: 'Use restic' }]),
  [{ label: 'Cancel', description: 'Cancel' }, { label: 'restic', description: 'Use restic' }]);
eq('blank label falls back to description',
  normalizeGuidanceOptions([{ label: '  ', description: 'Do the thing' }]),
  [{ label: 'Do the thing', description: 'Do the thing' }]);
eq('undefined stays undefined', normalizeGuidanceOptions(undefined), undefined);
eq('empty array stays undefined', normalizeGuidanceOptions([]), undefined);

console.log('\nbuttonText (Telegram 64-char limit)');
const long = 'Snapshot via btrfs send/receive — fastest for local, needs a btrfs subvolume layout';
eq('long label is clamped', buttonText(long).length <= TELEGRAM_BUTTON_TEXT_LIMIT, true);
eq('clamped label ends with an ellipsis', buttonText(long).endsWith('…'), true);
eq('short label untouched', buttonText('rsync'), 'rsync');
eq('exactly-at-limit label untouched',
  buttonText('x'.repeat(TELEGRAM_BUTTON_TEXT_LIMIT)), 'x'.repeat(TELEGRAM_BUTTON_TEXT_LIMIT));
// The real end-to-end guarantee: even a long plain string still yields a legal button.
eq('string[] with a long option still yields a legal button',
  normalizeGuidanceOptions([long])!.every((o) => buttonText(o.label).length <= TELEGRAM_BUTTON_TEXT_LIMIT), true);

console.log('\nformatGuidanceOptionList (message body)');
eq('label + description enumerated',
  formatGuidanceOptionList(objectOptions),
  '1. rsync — Use rsync over SSH — simple, no dedup\n2. restic — Use restic to a remote repo — encrypted, deduped');
eq('identical label/description is not duplicated',
  formatGuidanceOptionList(normalizeGuidanceOptions(['Yes', 'No'])!),
  '1. Yes\n2. No');
eq('body keeps the full untruncated description',
  formatGuidanceOptionList(normalizeGuidanceOptions([long])!).includes(long), true);

console.log('\nguidanceOptionsFromRow (DB round-trip)');
eq('paired columns rebuild the options',
  guidanceOptionsFromRow(objectOptions.map((o) => o.description), objectOptions.map((o) => o.label)),
  objectOptions);
eq('legacy row (labels null) falls back to description',
  guidanceOptionsFromRow(['Use rsync over SSH'], null),
  [{ label: 'Use rsync over SSH', description: 'Use rsync over SSH' }]);
eq('no options → undefined', guidanceOptionsFromRow(null, null), undefined);

console.log('\nrequest_guidance input schema');
// Mirrors the union in src/lib/tools/communication.ts.
const optionSchema = z.array(
  z.union([z.string(), z.object({ label: z.string(), description: z.string() })]),
).optional();
eq('accepts string[]', optionSchema.safeParse(['Yes', 'No']).success, true);
eq('accepts object options', optionSchema.safeParse(objectOptions).success, true);
eq('accepts mixed', optionSchema.safeParse(['Yes', objectOptions[0]]).success, true);
eq('rejects an option missing description',
  optionSchema.safeParse([{ label: 'rsync' }]).success, false);

console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
