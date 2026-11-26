/**
 * Inbound Telegram attachments (#97): image parts on the current user message,
 * attachment extraction, notes, filenames and album grouping.
 *
 * Run: pnpm test:telegram-attachments
 */

import type { ModelMessage } from 'ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message as TgMessage } from 'grammy/types';
import { prependToUserContent, toModelMessages } from '../src/lib/agent/turn-parts';
import {
  MediaGroupBuffer,
  buildAttachmentNote,
  downloadAttachments,
  extractAttachments,
  inboxPath,
  isVisionImage,
  loadVisionImages,
  safeFileName,
} from '../src/lib/telegram/attachments';

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


async function telegramTests(): Promise<void> {
  console.log('\n=== extractAttachments ===\n');
  const base = { message_id: 1, date: 0, chat: { id: 5, type: 'private', first_name: 'x' } };
  const msg = (extra: object) => ({ ...base, ...extra }) as unknown as TgMessage;

  ok('a text message has no attachments', extractAttachments(msg({ text: 'hi' })).length === 0);
  ok('a sticker is ignored', extractAttachments(msg({ sticker: { file_id: 's', file_unique_id: 'su', width: 1, height: 1, is_animated: false, is_video: false, type: 'regular' } })).length === 0);

  const photo = extractAttachments(msg({
    caption: 'look',
    photo: [
      { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 1000 },
      { file_id: 'big', file_unique_id: 'u3', width: 1280, height: 960, file_size: 90000 },
      { file_id: 'mid', file_unique_id: 'u2', width: 320, height: 240, file_size: 9000 },
    ],
  }));
  ok('a photo yields one attachment, the largest size', photo.length === 1 && photo[0].fileId === 'big' && photo[0].kind === 'photo', photo);
  ok('a photo is image/jpeg', photo[0].mediaType === 'image/jpeg');

  const doc = extractAttachments(msg({ document: { file_id: 'd', file_unique_id: 'du', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 42 } }));
  ok('a document keeps name, type and size', doc[0].kind === 'document' && doc[0].fileName === 'report.pdf' && doc[0].mediaType === 'application/pdf' && doc[0].size === 42, doc);

  const voice = extractAttachments(msg({ voice: { file_id: 'v', file_unique_id: 'vu', duration: 3 } }));
  ok('a voice note without mime type falls back to audio/ogg', voice[0].kind === 'voice' && voice[0].mediaType === 'audio/ogg', voice);

  const gif = extractAttachments(msg({
    animation: { file_id: 'a', file_unique_id: 'au', width: 1, height: 1, duration: 1, mime_type: 'video/mp4' },
    document: { file_id: 'a', file_unique_id: 'au', mime_type: 'video/mp4' },
  }));
  ok('an animation is not doubled as a document', gif.length === 1 && gif[0].kind === 'animation', gif);

  const vn = extractAttachments(msg({ video_note: { file_id: 'n', file_unique_id: 'nu', length: 1, duration: 1 } }));
  ok('a video note is video/mp4', vn[0].kind === 'video_note' && vn[0].mediaType === 'video/mp4', vn);

  console.log('\n=== safeFileName / inboxPath ===\n');
  ok('keeps a plain filename', safeFileName({ kind: 'document', fileName: 'report.pdf', mediaType: 'application/pdf' }) === 'report.pdf');
  ok('strips path separators and odd characters',
    safeFileName({ kind: 'document', fileName: '../../etc/pass wd;rm.txt', mediaType: 'text/plain' }) === 'etc_pass_wd_rm.txt',
    safeFileName({ kind: 'document', fileName: '../../etc/pass wd;rm.txt', mediaType: 'text/plain' }));
  ok('falls back to <kind>.<ext> without a name', safeFileName({ kind: 'photo', mediaType: 'image/jpeg' }) === 'photo.jpg');
  ok('falls back when the name has nothing usable', safeFileName({ kind: 'voice', fileName: '…', mediaType: 'audio/ogg' }) === 'voice.ogg',
    safeFileName({ kind: 'voice', fileName: '…', mediaType: 'audio/ogg' }));
  const long = safeFileName({ kind: 'document', fileName: `${'a'.repeat(200)}.pdf`, mediaType: 'application/pdf' });
  ok('caps long names and keeps the extension', long.length === 80 && long.endsWith('.pdf'), long);

  const when = new Date(2026, 10, 26, 9, 5, 7);
  const p = inboxPath('/ws', '-100123', { kind: 'photo', fileId: 'f', fileUniqueId: 'AbC/1', mediaType: 'image/jpeg' }, when);
  ok('inbox path is per chat, stamped and unique-id tagged', p === '/ws/inbox/telegram/-100123/20261126-090507-AbC1-photo.jpg', p);

  console.log('\n=== buildAttachmentNote ===\n');
  ok('no attachments, no note', buildAttachmentNote([]) === '');
  const note = buildAttachmentNote([
    { kind: 'photo', fileId: 'f', fileUniqueId: 'u', mediaType: 'image/jpeg', size: 2048, path: '/ws/inbox/a.jpg' },
    { kind: 'document', fileId: 'g', fileUniqueId: 'v', fileName: 'big.zip', mediaType: 'application/zip', size: 30 * 1024 * 1024, error: 'too large: 30.0 MB, limit 20.0 MB' },
  ]);
  ok('note says how many files', note.startsWith('[The user sent 2 files]'), note);
  ok('note gives kind, type, size and path', note.includes('- photo, image/jpeg, 2.0 KB: saved to /ws/inbox/a.jpg'), note);
  ok('note says why a file was not saved', note.includes('"big.zip": not saved (too large: 30.0 MB, limit 20.0 MB)'), note);
  ok('single file heading', buildAttachmentNote([{ kind: 'voice', fileId: 'f', fileUniqueId: 'u', mediaType: 'audio/ogg', path: '/x' }]).startsWith('[The user sent a file]'));

  console.log('\n=== downloadAttachments ===\n');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'opentalon-tg-attach-'));
  const token = '123:SECRET';
  const api = {
    token,
    getFile: async (id: string) => {
      if (id === 'broken') throw new Error(`fetch https://api.telegram.org/bot${token}/getFile failed`);
      return { file_id: id, file_unique_id: id, file_path: `photos/${id}.jpg` };
    },
  } as never;
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
  }) as unknown as typeof fetch;
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
  const saved = await downloadAttachments(api, ws, '42', [
    { kind: 'photo', fileId: 'ok', fileUniqueId: 'okU', mediaType: 'image/jpeg', size: 3 },
    { kind: 'document', fileId: 'huge', fileUniqueId: 'hU', mediaType: 'application/zip', size: 50 },
    { kind: 'document', fileId: 'broken', fileUniqueId: 'bU', mediaType: 'text/plain' },
  ], { maxBytes: 10 }, fakeFetch);
  console.error = origError;

  ok('downloads from the Bot API file endpoint', urls.length === 1 && urls[0] === `https://api.telegram.org/file/bot${token}/photos/ok.jpg`, urls);
  ok('saves the file under the chat inbox', !!saved[0].path && saved[0].path.startsWith(path.join(ws, 'inbox', 'telegram', '42')) && fs.readFileSync(saved[0].path).length === 3, saved[0]);
  ok('skips a file over the limit without fetching it', !saved[1].path && /too large/.test(saved[1].error ?? ''), saved[1]);
  ok('a failed download carries an error', !saved[2].path && !!saved[2].error, saved[2]);
  ok('the bot token never appears in the error or the log',
    !(saved[2].error ?? '').includes('SECRET') && errs.every((e) => !e.includes('SECRET')), { error: saved[2].error, errs });

  console.log('\n=== vision images ===\n');
  ok('jpeg/png/gif/webp are vision images', ['image/jpeg', 'image/png', 'image/gif', 'IMAGE/WEBP'].every(isVisionImage));
  ok('other images and non-images are not', !isVisionImage('image/heic') && !isVisionImage('application/pdf'));
  const imgs = await loadVisionImages([
    saved[0],
    { kind: 'document', fileId: 'x', fileUniqueId: 'x', mediaType: 'application/pdf', path: saved[0].path },
    saved[1],
  ]);
  ok('loads only saved vision images', imgs.length === 1 && imgs[0].mediaType === 'image/jpeg' && imgs[0].data.length === 3, imgs.length);
  fs.rmSync(ws, { recursive: true, force: true });

  console.log('\n=== MediaGroupBuffer ===\n');
  const pending = new Map<number, () => void>();
  let nextId = 0;
  const timers = {
    set: ((fn: () => void) => { const id = ++nextId; pending.set(id, fn); return id; }) as unknown as typeof setTimeout,
    clear: ((id: number) => { pending.delete(id); }) as unknown as typeof clearTimeout,
  };
  const flushed: Array<[string, number[]]> = [];
  const buf = new MediaGroupBuffer<number>(1500, (k, items) => flushed.push([k, items]), timers);
  buf.add('chat:album', 1);
  buf.add('chat:album', 2);
  buf.add('chat:other', 9);
  buf.add('chat:album', 3);
  ok('each new item restarts the group timer', pending.size === 2, pending.size);
  for (const fn of [...pending.values()]) fn();
  const album = flushed.find(([k]) => k === 'chat:album');
  ok('an album flushes once with every item, in order', flushed.length === 2 && JSON.stringify(album?.[1]) === '[1,2,3]', flushed);
  ok('flushed groups are forgotten', buf.size === 0);
}

telegramTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
