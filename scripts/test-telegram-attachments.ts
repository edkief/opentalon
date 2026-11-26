/**
 * Inbound Telegram attachments (#97): image parts on the current user message,
 * attachment extraction, notes, filenames and album grouping.
 *
 * Run: pnpm test:telegram-attachments
 */

import type { ModelMessage } from 'ai';
import { prependToUserContent, toModelMessages } from '../src/lib/agent/turn-parts';

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('=== image parts on the user message ===\n');

{
  const plain = toModelMessages({ role: 'user', content: 'hi' });
  ok('a user message without images stays a plain string', plain.length === 1 && plain[0].content === 'hi', plain);

  const bytes = new Uint8Array([1, 2, 3]);
  const [m] = toModelMessages({ role: 'user', content: 'what is this?', images: [{ data: bytes, mediaType: 'image/png' }] });
  const parts = Array.isArray(m.content) ? m.content : [];
  ok('a user message with images becomes text + image parts', parts.length === 2, m);
  ok('the text part comes first', parts[0]?.type === 'text' && (parts[0] as { text: string }).text === 'what is this?');
  ok('the image part carries bytes and media type',
    parts[1]?.type === 'image' && (parts[1] as { image: unknown }).image === bytes && (parts[1] as { mediaType: string }).mediaType === 'image/png');

  const [a] = toModelMessages({ role: 'assistant', content: 'ok', images: [{ data: bytes, mediaType: 'image/png' }] } as never);
  ok('images on a non-user message are ignored', a.content === 'ok', a);
}

console.log('\n=== prependToUserContent ===\n');

{
  const s = prependToUserContent({ role: 'user', content: 'body' }, 'pre\n');
  ok('prefixes a string message', s.content === 'pre\nbody', s);

  const multi: ModelMessage = { role: 'user', content: [{ type: 'image', image: new Uint8Array(), mediaType: 'image/png' }, { type: 'text', text: 'body' }] };
  const p = prependToUserContent(multi, 'pre\n');
  const parts = p.content as Array<{ type: string; text?: string }>;
  ok('prefixes the first text part of a multi-part message', parts[1].text === 'pre\nbody' && parts[0].type === 'image', p);
  ok('does not mutate the original message', (multi.content as Array<{ text?: string }>)[1].text === 'body');

  const noText = prependToUserContent({ role: 'user', content: [{ type: 'image', image: new Uint8Array(), mediaType: 'image/png' }] }, 'pre');
  const nt = noText.content as Array<{ type: string; text?: string }>;
  ok('adds a leading text part when there is none', nt[0].type === 'text' && nt[0].text === 'pre' && nt.length === 2, noText);

  const sys: ModelMessage = { role: 'system', content: 'x' };
  ok('leaves non-user messages alone', prependToUserContent(sys, 'pre') === sys);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
