/**
 * Unit tests for the embed page-context envelope (src/lib/embed/context.ts):
 * validation/stripping, version derivation, and the system-prompt rendering.
 *
 * The rendering assertions matter more than they look: the block is appended to
 * the CACHED STABLE half of the system prompt (llm-executor.ts:177), so it must
 * be a pure function of the resource plus the context version. Anything varying
 * per request in here costs a full cache miss on every single turn.
 *
 * Run: pnpm test:embed-context
 */

import {
  EmbedResourceContextSchema,
  EmbedResourceSchema,
  contextVersionOf,
  renderContextBlock,
  type EmbedResourceContext,
} from '../src/lib/embed/context';

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

console.log('=== Embed page context ===\n');

// ── Validation ───────────────────────────────────────────────────────────────
console.log('validation');
{
  const parsed = EmbedResourceContextSchema.safeParse({
    version: 'v1',
    summary: 'A page about widgets.',
    outline: ['Intro', 'Details'],
    facts: { author: 'Ed', sections: 2, draft: false },
    injected: 'ignore me',
  });
  ok('accepts a well-formed envelope', parsed.success);
  eq('strips unknown keys', parsed.success && 'injected' in parsed.data, false);
  eq('keeps declared keys', parsed.success && parsed.data.outline, ['Intro', 'Details']);
}
eq(
  'rejects a non-scalar fact',
  EmbedResourceContextSchema.safeParse({ facts: { nested: { a: 1 } } }).success,
  false,
);
eq('rejects an over-long summary', EmbedResourceContextSchema.safeParse({ summary: 'x'.repeat(20_001) }).success, false);
eq('resource requires an id', EmbedResourceSchema.safeParse({ title: 'No id' }).success, false);
eq('resource accepts an id alone', EmbedResourceSchema.safeParse({ id: 'demo-abc123' }).success, true);

// ── Version derivation ───────────────────────────────────────────────────────
console.log('\nversion derivation');
eq('null context has no version', contextVersionOf(null), null);
eq('explicit version wins', contextVersionOf({ version: 'v7', summary: 'x' }), 'v7');
{
  const a: EmbedResourceContext = { summary: 'A page about widgets.' };
  const b: EmbedResourceContext = { summary: 'A page about widgets.' };
  const c: EmbedResourceContext = { summary: 'A page about sprockets.' };
  eq('derived version is stable for equal content', contextVersionOf(a), contextVersionOf(b));
  ok('derived version changes with content', contextVersionOf(a) !== contextVersionOf(c));
}

// ── Rendering ────────────────────────────────────────────────────────────────
console.log('\nrendering');
const base = {
  chatId: 'embed:talonpress:abcdef0123456789',
  clientLabel: 'TalonPress',
  resourceId: 'demo-abc123',
  title: 'Widget Handbook',
  url: 'https://pages.example.com/pub/demo-abc123/',
  maxChars: 4000,
  workspaceDir: '/workspace',
  skillsContext: '\n\nNo skills saved yet.',
};

const context: EmbedResourceContext = {
  version: 'v3',
  visibility: 'private',
  summary: 'Everything about widgets.',
  outline: ['Intro', 'Assembly'],
  facts: { author: 'Ed', sections: 2 },
};

const rendered = renderContextBlock({ ...base, context, contextVersion: 'v3' });

ok('names the host', rendered.includes('TalonPress'));
ok('names the page', rendered.includes('Widget Handbook'));
ok('carries the resource id so tools can target it', rendered.includes('demo-abc123'));
ok('carries the url', rendered.includes(base.url));
ok('carries the version', rendered.includes('v3'));
ok('carries visibility', rendered.includes('private'));
ok('renders the summary', rendered.includes('Everything about widgets.'));
ok('renders the outline', rendered.includes('- Assembly'));
ok('renders facts', rendered.includes('- author: Ed'));
ok('points at the workspace', rendered.includes('/workspace'));
ok('appends the skills context', rendered.includes('No skills saved yet.'));

// The cacheability property, stated as a test so a future edit that interpolates
// a timestamp or the message text fails here rather than silently in production.
console.log('\ncacheability');
{
  const first = renderContextBlock({ ...base, context, contextVersion: 'v3' });
  const second = renderContextBlock({ ...base, context, contextVersion: 'v3' });
  eq('identical inputs render byte-identically', first, second);
  ok('no ISO timestamp leaked in', !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first));
}
{
  const changed = renderContextBlock({
    ...base,
    context: { ...context, version: 'v4', summary: 'Rewritten.' },
    contextVersion: 'v4',
  });
  ok('changed context renders differently', changed !== rendered);
}

console.log('\nabsent and oversized context');
{
  const none = renderContextBlock({ ...base, context: null, contextVersion: null });
  ok('still identifies the page with no context', none.includes('demo-abc123'));
  ok('omits the context heading', !none.includes('## Page context'));
}
{
  const big = renderContextBlock({
    ...base,
    context: { version: 'v9', summary: 'x'.repeat(5000) },
    contextVersion: 'v9',
    maxChars: 500,
  });
  ok('truncates past maxChars', big.includes('Page context truncated'));
  // The tail (workspace, skills, instructions) is appended after truncation, so
  // the total is longer than maxChars by design — the cap is on the host's blob.
  ok('keeps the workspace instructions after truncating', big.includes('/workspace'));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
