/**
 * Unit tests for fresh-text extraction (src/lib/email/reply-extract.ts).
 *
 * Covers Gmail / Outlook / Apple Mail quoting styles, HTML-only mail (converted
 * upstream), signatures, and the critical rule that a mention keyword appearing
 * ONLY in a quoted trail must NOT trigger a reply.
 *
 * Run: pnpm test:email-extract
 */

import { convert as htmlToText } from 'html-to-text';
import { extractFreshText } from '../src/lib/email/reply-extract';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function contains(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

console.log('=== Email Fresh-Text Extraction ===\n');

// ── Gmail ──
const gmail = `Yes, let's proceed with the plan.

On Mon, Jul 12, 2026 at 9:00 AM Alice <alice@x.com> wrote:
> Are we good to go?
> Please confirm.`;
{
  const fresh = extractFreshText(gmail);
  ok('gmail: keeps fresh line', contains(fresh, "let's proceed"));
  ok('gmail: drops quoted question', !contains(fresh, 'good to go'));
}

// ── Outlook (Original Message header) ──
const outlook = `Approved on my end.

-----Original Message-----
From: Bob <bob@x.com>
Sent: Monday, July 12, 2026 9:00 AM
To: Agent
Subject: Approval

Can you approve this?`;
{
  const fresh = extractFreshText(outlook);
  ok('outlook: keeps fresh line', contains(fresh, 'approved on my end'));
  ok('outlook: drops quoted body', !contains(fresh, 'can you approve'));
}

// ── Apple Mail ("On <date>, <who> wrote:") ──
const apple = `Sounds perfect, thanks!

On Jul 12, 2026, at 9:00 AM, Carol <carol@x.com> wrote:

> Does this time work for you?`;
{
  const fresh = extractFreshText(apple);
  ok('apple: keeps fresh line', contains(fresh, 'sounds perfect'));
  ok('apple: drops quoted question', !contains(fresh, 'does this time work'));
}

// ── Signature stripping ──
const withSig = `Here is the summary you asked for.

--
Dave
Sent from my phone`;
{
  const fresh = extractFreshText(withSig);
  ok('signature: keeps body', contains(fresh, 'summary you asked for'));
  ok('signature: drops signature', !contains(fresh, 'sent from my phone'));
}

// ── HTML-only mail (converted upstream via html-to-text) ──
const html = `<div><p>Ship it today please.</p></div>
<blockquote>Earlier: should we ship?</blockquote>`;
{
  const body = htmlToText(html, { wordwrap: false });
  const fresh = extractFreshText(body);
  ok('html-only: keeps fresh instruction', contains(fresh, 'ship it today'));
}

// ── Fallback: no quoted trail returns the full body ──
{
  const fresh = extractFreshText('Just a plain first message.');
  ok('fallback: returns full body when no quote', contains(fresh, 'plain first message'));
}

// ── CRITICAL: mention keyword only in quoted trail must NOT trigger ──
const keywordInQuoteOnly = `Thanks for the update, looks fine.

On Mon, Jul 12, 2026 at 9:00 AM Eve <eve@x.com> wrote:
> hey agent, can you handle this?`;
{
  const fresh = extractFreshText(keywordInQuoteOnly);
  ok('mention-in-quote: keyword absent from fresh text', !contains(fresh, 'hey agent'));
  ok('mention-in-quote: fresh text preserved', contains(fresh, 'looks fine'));
}

// ── Mention keyword in fresh text DOES survive ──
const keywordFresh = `hey agent, please summarize the thread.

On Mon, Jul 12, 2026 at 9:00 AM Eve <eve@x.com> wrote:
> original message`;
{
  const fresh = extractFreshText(keywordFresh);
  ok('mention-in-fresh: keyword present', contains(fresh, 'hey agent'));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
