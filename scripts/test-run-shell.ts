/**
 * Regression checks for run_shell with background processes (#81) and the
 * wait_for tool that waits on them in one step (#82).
 *
 * Run with: pnpm test:run-shell
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configManager } from '../src/lib/config/config-manager';
import { runShell, waitFor } from '../src/lib/tools/terminal';
import { createLoopBreaker, LOOP_BREAKER_DEFAULTS } from '../src/lib/tools/loop-breaker';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'run-shell-'));
process.env.AGENT_WORKSPACE = WORKSPACE;
const cfg = configManager.get();
cfg.tools = { ...(cfg.tools ?? {}), agentWorkspace: WORKSPACE, shell: '/bin/bash', commandTimeoutMs: 5_000 };

let failed = 0;
function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
}

const spawned: number[] = [];
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function timed(command: string): Promise<{ out: string; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const out = await runShell(command);
    return { out, ms: Date.now() - start };
  } catch (err) {
    return { out: '', ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function backgroundCase(label: string, command: string): Promise<void> {
  const pidFile = path.join(WORKSPACE, `${label.replace(/\W+/g, '-')}.pid`);
  const r = await timed(command.replaceAll('PIDFILE', pidFile));
  ok(`${label}: returns in under 2s (${r.ms}ms)`, r.ms < 2_000 && !r.error, r.error);
  ok(`${label}: foreground output comes back`, r.out.includes('ok'), r.out);
  const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
  spawned.push(pid);
  ok(`${label}: background process still running`, alive(pid));
}

async function main(): Promise<void> {
  console.log('run_shell with background processes');
  await backgroundCase('redirected, after &&', 'cd /tmp && sleep 120 > /dev/null 2>&1 & echo $! > PIDFILE; echo ok');
  await backgroundCase('no redirect', 'sleep 120 & echo $! > PIDFILE; echo ok');
  await backgroundCase('nohup, after &&', `cd ${WORKSPACE} && nohup sleep 120 > bg.log 2>&1 & echo $! > PIDFILE; echo ok`);
  await backgroundCase('setsid & disown', 'setsid nohup sleep 120 > /dev/null 2>&1 < /dev/null & echo $! > PIDFILE; disown; sleep 0.2; echo ok');

  console.log('foreground behaviour');
  const plain = await timed('echo hello; echo oops >&2');
  ok('stdout and stderr are combined', plain.out === 'hello\n\n--- stderr ---\noops\n', plain.out);
  const empty = await timed('true');
  ok('no output reports (no output)', empty.out === '(no output)', empty.out);
  const fail = await timed('echo partial; echo boom >&2; exit 3');
  ok('non-zero exit throws with code and stderr', !!fail.error?.includes('exit 3') && fail.error.includes('boom'), fail.error);
  cfg.tools!.commandTimeoutMs = 1_000;
  const slow = await timed('sleep 5');
  ok(`foreground overrun is killed at the timeout (${slow.ms}ms)`, slow.ms < 2_500 && slow.error === 'run_shell timed out after 1000ms and was killed', slow.error);
  cfg.tools!.commandTimeoutMs = 5_000;
  const big = await timed('head -c 2000000 /dev/zero | tr "\\0" a');
  ok('output over the buffer limit is killed and reported', !!big.error?.includes('exceeded'), big.error);

  console.log('wait_for');
  const pidOut = await runShell('sleep 2 & echo $!');
  const pid = Number(pidOut.trim());
  spawned.push(pid);
  let t = Date.now();
  const pidWait = await waitFor({ pid, timeout_seconds: 10 });
  ok(`returns when the pid exits (${Date.now() - t}ms)`, pidWait.startsWith('Finished') && pidWait.includes(`process ${pid} exited`), pidWait);

  const log = path.join(WORKSPACE, 'job.log');
  await runShell(`(for i in 1 2 3; do echo "line $i"; sleep 0.5; done; echo DONE) > ${log} 2>&1 &`);
  t = Date.now();
  const patternWait = await waitFor({ path: log, pattern: '^DONE$', timeout_seconds: 10 });
  ok(`returns when the pattern matches (${Date.now() - t}ms)`, patternWait.startsWith('Finished') && patternWait.includes('line 3\nDONE'), patternWait);

  const marker = path.join(WORKSPACE, 'done.marker');
  await runShell(`(sleep 1; echo 0 > ${marker}) > /dev/null 2>&1 &`);
  const fileWait = await waitFor({ path: 'done.marker', timeout_seconds: 10 });
  ok('returns when the file appears (workspace-relative path)', fileWait.startsWith('Finished') && fileWait.includes('done.marker exists'), fileWait);

  t = Date.now();
  const timedOut = await waitFor({ path: 'never.log', pattern: 'x', timeout_seconds: 1 });
  ok(`times out with "Still running" (${Date.now() - t}ms)`, timedOut.startsWith('Still running') && timedOut.includes('does not exist yet') && Date.now() - t < 2_000, timedOut);

  cfg.tools!.maxWaitMs = 1_000;
  const capped = await waitFor({ path: 'never.log', timeout_seconds: 999 });
  ok('a timeout over tools.maxWaitMs is capped and says so', capped.includes('capped at 1s'), capped);
  cfg.tools!.maxWaitMs = undefined;

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancelled')), 300);
  t = Date.now();
  const aborted = await waitFor({ path: 'never.log', timeout_seconds: 30 }, controller.signal).then(
    () => 'resolved',
    (err: Error) => err.message,
  );
  ok(`an abort ends the wait (${Date.now() - t}ms)`, aborted === 'cancelled' && Date.now() - t < 1_000, aborted);

  ok('pid or path is required', (await waitFor({})).startsWith('Error:'));
  ok('pattern needs a path', (await waitFor({ pid: 1, pattern: 'x' })).startsWith('Error:'));
  ok('a bad regex is reported', (await waitFor({ path: log, pattern: '(' })).startsWith('Error: invalid pattern'));

  console.log('loop breaker and wait_for');
  const breaker = createLoopBreaker({ ...LOOP_BREAKER_DEFAULTS });
  const input = { path: 'never.log', timeout_seconds: 1 };
  for (let i = 0; i < 5; i++) breaker.record('wait_for', input, timedOut);
  ok('repeated timed-out waits never trip it', breaker.check('wait_for', input) === null);
  for (let i = 0; i < 2; i++) breaker.record('wait_for', input, fileWait);
  ok('repeating a finished wait still trips it', breaker.check('wait_for', input) === 2);
}

main()
  .catch((err) => {
    failed += 1;
    console.error(err);
  })
  .finally(() => {
    for (const pid of spawned) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    if (failed) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll run_shell checks passed');
    process.exit(0);
  });
