/**
 * Regression checks for run_shell with background processes (#81).
 *
 * Run with: pnpm test:run-shell
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configManager } from '../src/lib/config/config-manager';
import { runShell } from '../src/lib/tools/terminal';

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
