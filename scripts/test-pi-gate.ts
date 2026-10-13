/**
 * The pi permission gate (#70): the request parsing and load check in src/lib/harness/pi/gate.ts,
 * and PiSession answering gate requests, driven against the fake pi in scripts/fixtures/pi/, which
 * replays sessions recorded with the gate (gate-allow, gate-block, gate-cancelled, gate-write).
 *
 * Run: pnpm test:pi-gate
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '../src/lib/harness/events';
import { HarnessError } from '../src/lib/harness/events';
import type { PiHarnessConfig } from '../src/lib/harness/pi/config';
import { GATE_TITLE, gateExtensionPath, gateLoaded, isInside, parseGateFrame, type GateCall, type GateVerdict } from '../src/lib/harness/pi/gate';
import { PiSession } from '../src/lib/harness/pi/session';

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

const work = mkdtempSync(join(tmpdir(), 'opentalon-pi-gate-'));
const fakePi = join(__dirname, 'fixtures', 'pi', 'fake-pi.mjs');
const binary = join(work, 'pi');
writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`);
chmodSync(binary, 0o755);

const config: PiHarnessConfig = { enabled: true, binary, trustProject: false, args: [], sessionDir: join(work, 'sessions') };

let runs = 0;
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

function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (test()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
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

const frame = (placeholder: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'extension_ui_request', id: 'g1', method: 'input', title: GATE_TITLE,
  placeholder: typeof placeholder === 'string' ? placeholder : JSON.stringify(placeholder), ...extra,
});

/** The tool output pi reported for the run's first call. */
const firstOutput = (events: HarnessEvent[]) => {
  const finished = events.find((event) => event.type === 'tool.finished');
  return finished?.type === 'tool.finished' ? finished : undefined;
};

const decided = (events: HarnessEvent[]) => events.filter((event) => event.type === 'permission.decided');

async function main(): Promise<void> {
  console.log('=== Gate requests ===\n');
  {
    const parsed = parseGateFrame(frame({ v: 1, id: 'call_1', tool: 'bash', input: { command: 'ls' } }));
    ok('a gate request is read', !!parsed && 'call' in parsed && parsed.call.tool === 'bash' && parsed.call.id === 'call_1' && parsed.call.input.command === 'ls', parsed);
    const noInput = parseGateFrame(frame({ v: 1, tool: 'read' }));
    ok('…with no input, as an empty one', !!noInput && 'call' in noInput && Object.keys(noInput.call.input).length === 0, noInput);
    ok('another dialog is not a gate request', parseGateFrame(frame({ v: 1, tool: 'bash' }, { title: 'something else' })) === undefined);
    ok('nor a gate-titled dialog of another method', parseGateFrame(frame({ v: 1, tool: 'bash' }, { method: 'confirm' })) === undefined);
    const notJson = parseGateFrame(frame('not json'));
    ok('a request that is not JSON is malformed', !!notJson && 'malformed' in notJson, notJson);
    const wrongVersion = parseGateFrame(frame({ v: 2, tool: 'bash' }));
    ok('a request of another version is malformed', !!wrongVersion && 'malformed' in wrongVersion, wrongVersion);
    const noTool = parseGateFrame(frame({ v: 1, input: {} }));
    ok('a request naming no tool is malformed', !!noTool && 'malformed' in noTool, noTool);
  }

  console.log('\n=== Load check ===\n');
  {
    const command = { name: 'opentalon-gate', source: 'extension', sourceInfo: { path: '/app/extensions/pi/opentalon-gate.mjs' } };
    ok('the gate command from the extension counts as loaded', gateLoaded([command]));
    ok('…numbered, when two extensions register it', gateLoaded([{ ...command, name: 'opentalon-gate:1' }]));
    ok('a skill of the same name does not', !gateLoaded([{ ...command, source: 'skill' }]));
    ok('the command from another file does not', !gateLoaded([{ ...command, sourceInfo: { path: '/repo/.pi/evil.mjs' } }]));
    ok('no commands, or no list, is not loaded', !gateLoaded([]) && !gateLoaded(undefined));
    ok('the extension ships at its default path', gateExtensionPath().endsWith(join('extensions', 'pi', 'opentalon-gate.mjs')));
  }
  {
    const { env, log } = fake({ gate: 'missing' });
    let error: unknown;
    await PiSession.start({ cwd: work, env, config }).catch((cause) => (error = cause));
    ok('a pi that did not load the gate is refused at startup', error instanceof HarnessError && /permission extension/.test(error.message), String(error));
    ok('…as a fault of pi, not of the model (no fallback to the next model)', error instanceof HarnessError && error.status !== 400);
    ok('…and its process is stopped', !alive(logged(log)[0]?.pid));
  }
  {
    const { env, log } = fake({ captures: ['tool-turn'] });
    const session = await PiSession.start({ cwd: work, env, config });
    const argv = logged(log)[0]?.argv ?? [];
    ok('pi is started with the gate extension', argv.includes('--extension') && argv[argv.indexOf('--extension') + 1] === gateExtensionPath(), argv);
    await session.stop();
  }

  console.log('\n=== Answering the gate ===\n');
  {
    const calls: GateCall[] = [];
    const { env, log } = fake({ captures: ['gate-allow'] });
    const session = await PiSession.start({ cwd: work, env, config, gate: async (call) => (calls.push(call), { allow: true, decision: 'allowed' }) });
    const events = collect(session);
    const ended = await session.run('run it');
    ok('an allowed call runs', ended.outcome === 'succeeded' && firstOutput(events)?.status === 'success' && firstOutput(events)?.output === 'hello\n', firstOutput(events));
    ok('the handler is given the tool and its input', calls.length === 1 && calls[0].tool === 'bash' && calls[0].input.command === 'echo hello', calls);
    ok('pi is answered exactly {"allow":true}', logged(log).some((entry) => entry.command?.type === 'extension_ui_response' && entry.command.value === '{"allow":true}'));
    const asked = events.find((event) => event.type === 'permission.asked');
    ok('the request is reported, tied to the tool call', asked?.type === 'permission.asked' && asked.call === 'call_1' && asked.tool === 'bash', asked);
    const [decision] = decided(events);
    ok('…and so is the decision', decision?.type === 'permission.decided' && decision.decision === 'allowed' && decision.call === 'call_1', decision);
    await session.stop();
  }
  {
    const reason = 'The user denied run_shell. Do not try another way round it; carry on without it.';
    const { env } = fake({ captures: ['gate-block'] });
    const session = await PiSession.start({ cwd: work, env, config, gate: async (): Promise<GateVerdict> => ({ allow: false, decision: 'denied', reason }) });
    const events = collect(session);
    const ended = await session.run('run it');
    const output = firstOutput(events);
    ok('a blocked call does not run, and the agent is told why', ended.outcome === 'succeeded' && output?.status === 'error' && output.output === reason, output);
    const [decision] = decided(events);
    ok('…and the denial is reported with its reason', decision?.type === 'permission.decided' && decision.decision === 'denied' && decision.reason === reason, decision);
    await session.stop();
  }
  {
    const { env } = fake({ captures: ['gate-block'] });
    const session = await PiSession.start({ cwd: work, env, config });
    const events = collect(session);
    await session.run('run it');
    const output = firstOutput(events);
    ok('with no handler, every call is blocked (fail closed)', output?.status === 'error' && /Nothing in OpenTalon can approve/.test(output.output ?? ''), output);
    await session.stop();
  }
  {
    const { env } = fake({ captures: ['gate-block'] });
    const session = await PiSession.start({ cwd: work, env, config, gate: async () => { throw new Error('boom'); } });
    const events = collect(session);
    await session.run('run it');
    const output = firstOutput(events);
    ok('a handler that throws blocks the call', output?.status === 'error' && /permission check failed \(boom\)/.test(output.output ?? ''), output);
    await session.stop();
  }
  {
    const calls: GateCall[] = [];
    const { env } = fake({ captures: ['gate-block'], swap: { '"v":1': '"v":9' } });
    const session = await PiSession.start({ cwd: work, env, config, gate: async (call) => (calls.push(call), { allow: true, decision: 'allowed' }) });
    const events = collect(session);
    await session.run('run it');
    const output = firstOutput(events);
    ok('a malformed request is blocked without asking the handler', calls.length === 0 && output?.status === 'error' && /could not read the permission request/.test(output.output ?? ''), output);
    const [decision] = decided(events);
    ok('…and reported as blocked', decision?.type === 'permission.decided' && decision.decision === 'blocked', decision);
    await session.stop();
  }
  {
    const { env } = fake({ captures: ['gate-write'] });
    const session = await PiSession.start({ cwd: work, env, config, gate: async (call) => (call.tool === 'write' && call.input.path === 'src/app.ts' && call.input.content === undefined ? { allow: true, decision: 'allowed' } : { allow: false, decision: 'blocked', reason: 'unexpected' }) });
    const events = collect(session);
    await session.run('write it');
    ok('a write is put to the gate by path, without its content', firstOutput(events)?.status === 'success', firstOutput(events));
    await session.stop();
  }
  {
    // A call left waiting when the turn ends is cancelled, which the extension takes as a block.
    let settle: (verdict: GateVerdict) => void = () => undefined;
    const { env, log } = fake({ captures: ['gate-cancelled', 'abort'] });
    const session = await PiSession.start({ cwd: work, env, config, gate: () => new Promise((resolve) => (settle = resolve)) });
    const events = collect(session);
    await session.prompt('run it');
    await until(() => events.some((event) => event.type === 'permission.asked'));
    await session.abort().catch(() => undefined);
    await until(() => events.some((event) => event.type === 'execution.ended'));
    await until(() => logged(log).some((entry) => entry.command?.type === 'extension_ui_response' && entry.command.cancelled === true));
    ok('a call still waiting when the turn ends is cancelled', true);
    const [decision] = decided(events);
    ok('…and reported as blocked', decision?.type === 'permission.decided' && decision.decision === 'blocked' && /run ended/.test(decision.reason ?? ''), decision);
    settle({ allow: true, decision: 'approved' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok('a decision arriving after the cancel is dropped', decided(events).length === 1 &&
      !logged(log).some((entry) => entry.command?.type === 'extension_ui_response' && entry.command.value === '{"allow":true}'));
    await session.stop();
  }

  console.log('\n=== Paths ===\n');
  ok('the workdir itself is inside it', isInside('/w/repo', '/w/repo'));
  ok('a file below it is inside', isInside('/w/repo', '/w/repo/src/a.ts'));
  ok('its parent is not', !isInside('/w/repo', '/w'));
  ok('a sibling sharing its prefix is not', !isInside('/w/repo', '/w/repo2/a.ts'));
  ok('a path elsewhere is not', !isInside('/w/repo', '/etc/passwd'));
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
