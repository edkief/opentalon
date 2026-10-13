/**
 * PiSession and the pi version check (#67), driven against the fake pi in scripts/fixtures/pi/,
 * which replays recorded pi 1.1 sessions over the real RPC protocol.
 *
 * Run: pnpm test:pi-session
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '../src/lib/harness/events';
import { HarnessError } from '../src/lib/harness/events';
import type { PiHarnessConfig } from '../src/lib/harness/pi/config';
import { PiSession } from '../src/lib/harness/pi/session';
import { checkPi } from '../src/lib/harness/pi/version';

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

const work = mkdtempSync(join(tmpdir(), 'opentalon-pi-session-'));
const fakePi = join(__dirname, 'fixtures', 'pi', 'fake-pi.mjs');
// pi is spawned as an executable: a wrapper stands in for the installed binary.
const binary = join(work, 'pi');
writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`);
chmodSync(binary, 0o755);

const config: PiHarnessConfig = {
  enabled: true,
  binary,
  trustProject: false,
  args: [],
  sessionDir: join(work, 'sessions'),
};

let runs = 0;
/** Options for one fake pi, and the file it logs its command line and every command to. */
function fake(options: Record<string, unknown>): { env: Record<string, string>; log: string } {
  const log = join(work, `fake-${++runs}.log`);
  return { env: { FAKE_PI: JSON.stringify({ log, ...options }) }, log };
}

function logged(log: string): Array<{ argv?: string[]; pid?: number; command?: Record<string, unknown> }> {
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function collect(session: PiSession): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  session.onEvent((event) => events.push(event));
  return events;
}

function until(events: HarnessEvent[], test: (event: HarnessEvent) => boolean, timeoutMs = 10_000): Promise<HarnessEvent> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = events.find(test);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for an event'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('=== A turn, start to end ===\n');
  {
    const { env, log } = fake({ captures: ['tool-turn'] });
    const session = await PiSession.start({ cwd: work, env, config });
    const events = collect(session);
    ok('the session id and file are pi\'s own', session.id.length > 0 && session.file.startsWith(config.sessionDir) && session.file.includes(session.id), session.file);
    const argv = logged(log)[0]?.argv ?? [];
    ok('pi runs in RPC mode, in the session dir, without project trust',
      argv.join(' ').startsWith(`--mode rpc --session-dir ${config.sessionDir} --no-approve`), argv);
    const ended = await session.run('Run echo hello then finish.');
    ok('run() resolves with the execution end, succeeded', ended.outcome === 'succeeded', ended);
    ok('the turn\'s events arrive in order, ending with execution.ended',
      events.some((event) => event.type === 'tool.called') && events.at(-1)?.type === 'execution.ended');
    ok('the prompt went to pi as sent', logged(log).some((entry) => entry.command?.type === 'prompt' && entry.command.message === 'Run echo hello then finish.'));
    ok('the session is idle again afterwards', !session.running && session.alive);
    const pid = logged(log)[0]?.pid;
    await session.stop();
    ok('stop() ends the pi process', !session.alive && !alive(pid));
  }

  console.log('\n=== Models ===\n');
  {
    const { env, log } = fake({ captures: ['tool-turn'] });
    const session = await PiSession.start({ cwd: work, env, config, model: 'stub/stub-model' });
    ok('a model asked for is set on pi', session.model === 'stub/stub-model' &&
      logged(log).some((entry) => entry.command?.type === 'set_model' && entry.command.provider === 'stub' && entry.command.modelId === 'stub-model'));
    await session.stop();
  }
  {
    const { env, log } = fake({});
    let error: unknown;
    await PiSession.start({ cwd: work, env, config, model: 'stub/nope' }).catch((cause) => (error = cause));
    ok('a model pi does not have refuses the start, with pi\'s reason', error instanceof HarnessError && /Model not found/.test(error.message), String(error));
    ok('…and leaves no process behind', !alive(logged(log)[0]?.pid));
  }
  {
    const { env } = fake({});
    let error: unknown;
    await PiSession.start({ cwd: work, env, config, model: 'no-slash' }).catch((cause) => (error = cause));
    ok('a model not in provider/id form is refused', error instanceof HarnessError && error.status === 400, String(error));
  }

  console.log('\n=== Stopping and failing ===\n');
  {
    const { env } = fake({ captures: ['abort'] });
    const session = await PiSession.start({ cwd: work, env, config });
    const events = collect(session);
    await session.prompt('Run the slow thing.');
    await until(events, (event) => event.type === 'tool.called');
    let second: unknown;
    await session.prompt('again').catch((cause) => (second = cause));
    ok('a session runs one turn at a time', second instanceof HarnessError && second.status === 409, String(second));
    await session.abort();
    const ended = await until(events, (event) => event.type === 'execution.ended');
    ok('abort() ends the turn as aborted', ended.type === 'execution.ended' && ended.outcome === 'aborted', ended);
    await session.stop();
  }
  {
    const { env } = fake({ captures: ['tool-turn'], exitAfter: 'tool_execution_start' });
    const session = await PiSession.start({ cwd: work, env, config });
    const ended = await session.run('Run echo hello then finish.');
    ok('pi dying mid-turn ends the turn as failed, saying how it exited',
      ended.outcome === 'failed' && /pi exited \(code 7\)/.test(ended.error ?? ''), ended);
    ok('…and the session is no longer alive', !session.alive);
  }
  {
    const { env, log } = fake({ captures: ['extension-dialog'] });
    const session = await PiSession.start({ cwd: work, env, config });
    const ended = await session.run('run it');
    const answer = logged(log).find((entry) => entry.command?.type === 'extension_ui_response');
    ok('an extension dialog is cancelled, since nobody can answer it mid-turn', answer?.command?.cancelled === true, answer);
    ok('…and the turn carries on to its end', ended.outcome === 'succeeded', ended);
    await session.stop();
  }

  console.log('\n=== Version check ===\n');
  const versionOf = async (version: string) => {
    process.env.FAKE_PI = JSON.stringify({ version });
    try {
      return await checkPi(binary);
    } finally {
      delete process.env.FAKE_PI;
    }
  };
  for (const version of ['1.1.0', '1.2.0', '1.9.3']) {
    const check = await versionOf(version);
    ok(`pi ${version} is accepted`, check.ok && check.version === version, check);
  }
  {
    const check = await versionOf('0.73.1');
    ok('the old 0.x package is refused, naming it', !check.ok && /@mariozechner\/pi-coding-agent/.test(check.detail), check);
  }
  {
    const check = await versionOf('2.0.0');
    ok('pi 2.x is refused as outside the tested range', !check.ok && /outside the versions/.test(check.detail), check);
  }
  {
    const check = await checkPi(join(work, 'no-such-pi'));
    ok('a missing binary says how to install pi', !check.ok && /not installed or not on the PATH \(npm install -g @earendil-works\/pi-coding-agent\)/.test(check.detail), check);
  }
}

main()
  .catch((err) => {
    failed++;
    console.error('  ✗ unexpected error:', err);
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
