/**
 * Unit tests for email address handling (src/lib/email/address.ts).
 * Run: pnpm test:email-address
 */

import {
  normalizeAddress,
  normalizeAddresses,
  buildAllowedSet,
  addressInSet,
  allParticipantsAllowed,
} from '../src/lib/email/address';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

console.log('=== Email Address ===\n');

console.log('normalizeAddress');
eq('lowercases + trims', normalizeAddress('  John@Example.COM '), 'john@example.com');
eq('strips +tag by default', normalizeAddress('user+newsletter@x.com'), 'user@x.com');
eq('keeps +tag when disabled', normalizeAddress('user+newsletter@x.com', false), 'user+newsletter@x.com');
eq('extracts from display name form', normalizeAddress('John Doe <John@X.com>'), 'john@x.com');
eq('empty for undefined', normalizeAddress(undefined), '');
eq('plus at local start strips whole local', normalizeAddress('+weird@x.com'), '@x.com');

console.log('\nnormalizeAddresses (dedup)');
eq('dedups case/plus variants', normalizeAddresses(['A@x.com', 'a+tag@x.com', 'b@x.com']), ['a@x.com', 'b@x.com']);

console.log('\nbuildAllowedSet + membership');
const allowed = buildAllowedSet(['friend@x.com'], ['agent@y.com', undefined]);
eq('whitelist member', addressInSet('Friend@X.com', allowed), true);
eq('own address member', addressInSet('agent+bot@y.com', allowed), true);
eq('outsider not member', addressInSet('stranger@z.com', allowed), false);

console.log('\nallParticipantsAllowed (privacy=private)');
eq('all inside → true', allParticipantsAllowed(['friend@x.com', 'agent@y.com'], allowed), true);
eq('one outsider → false', allParticipantsAllowed(['friend@x.com', 'stranger@z.com'], allowed), false);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
