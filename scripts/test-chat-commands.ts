/**
 * Unit tests for slash-command parsing (src/lib/commands/parse.ts) — the piece
 * that decides whether text typed into a non-Telegram channel is a harness
 * command or an ordinary message for the agent.
 * Run: pnpm test:chat-commands
 */

import { parseChatCommand, isChatCommand, CHAT_COMMAND_NAMES } from '../src/lib/commands/parse';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

console.log('=== Chat Commands ===\n');

console.log('recognised commands');
eq('bare command', parseChatCommand('/reset'), { name: 'reset', args: '' });
eq('trailing whitespace', parseChatCommand('  /status  '), { name: 'status', args: '' });
eq('uppercase name', parseChatCommand('/RESET'), { name: 'reset', args: '' });
eq('underscore name', parseChatCommand('/refresh_skills'), { name: 'refresh_skills', args: '' });
eq('single arg', parseChatCommand('/cancel now'), { name: 'cancel', args: 'now' });
eq('rest kept verbatim', parseChatCommand('/agent researcher find me a paper'), {
  name: 'agent',
  args: 'researcher find me a paper',
});
eq('multi-line args', parseChatCommand('/compact focus on\nthe deploy'), {
  name: 'compact',
  args: 'focus on\nthe deploy',
});
eq('telegram @mention suffix', parseChatCommand('/status@opentalon_bot'), { name: 'status', args: '' });
eq('every registered name parses', CHAT_COMMAND_NAMES.every((n) => parseChatCommand(`/${n}`)?.name === n), true);

console.log('\nnot commands (must reach the agent unchanged)');
eq('plain text', parseChatCommand('reset the thing'), null);
eq('unknown command', parseChatCommand('/frobnicate'), null);
eq('absolute path', parseChatCommand('/home/ekieffer/Dev/opentalon'), null);
eq('path with args', parseChatCommand('/etc/hosts is the file'), null);
eq('regex-ish', parseChatCommand('/^foo.*$/'), null);
eq('date', parseChatCommand('/2026 was a year'), null);
eq('lone slash', parseChatCommand('/'), null);
eq('empty string', parseChatCommand(''), null);
eq('command mid-sentence', parseChatCommand('run /reset for me'), null);

console.log('\nisChatCommand');
eq('true for known', isChatCommand('/help'), true);
eq('false for path', isChatCommand('/usr/bin/env'), false);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
