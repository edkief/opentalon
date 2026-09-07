/**
 * Regression tests for Telegram error classification and credential-safe logs.
 * Run: pnpm test:telegram-errors
 */

import { GrammyError, HttpError } from 'grammy';
import {
  isTelegramConnectionError,
  isTelegramFormattingError,
  telegramErrorSummary,
} from '../src/lib/telegram/errors';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}\n      expected: ${String(expected)}\n      actual:   ${String(actual)}`);
  }
}

const token = '123456:secret-token';
const timeout = new HttpError("Network request for 'sendMessage' failed!", {
  name: 'FetchError',
  code: 'ETIMEDOUT',
  errno: 'ETIMEDOUT',
  message: `request to https://api.telegram.org/bot${token}/sendMessage failed`,
});

const entityError = new GrammyError(
  "Call to 'sendMessage' failed! (400: Bad Request: can't parse entities)",
  {
    ok: false,
    error_code: 400,
    description: "Bad Request: can't parse entities: Unsupported start tag",
  },
  'sendMessage',
  { chat_id: '42' },
);

const forbidden = new GrammyError(
  "Call to 'sendMessage' failed! (403: Forbidden)",
  { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
  'sendMessage',
  { chat_id: '42' },
);

console.log('=== Telegram error handling ===\n');

eq('HttpError is classified as a connection failure', isTelegramConnectionError(timeout), true);
eq('HttpError is not classified as a formatting failure', isTelegramFormattingError(timeout), false);
eq('entity API error enables the plain-text fallback', isTelegramFormattingError(entityError), true);
eq('unrelated API error does not enable the plain-text fallback', isTelegramFormattingError(forbidden), false);
eq(
  'network summary includes method and low-level code',
  telegramErrorSummary(timeout),
  'connection failure method=sendMessage code=ETIMEDOUT',
);
eq('network summary does not leak the bot token', telegramErrorSummary(timeout).includes(token), false);

console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
