/**
 * runPiTask (#68): one specialist task run in pi, against the fake pi in scripts/fixtures/pi/
 * (recorded pi 1.1 sessions over the real RPC protocol). Plus the provider-key mapping and
 * the harness system prompt.
 *
 * Run: pnpm test:pi-task
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiHarnessConfig } from '../src/lib/harness/pi/config';
import { buildHarnessSystemPrompt } from '../src/lib/harness/pi/prompt';
import { piProviderEnv } from '../src/lib/harness/pi/provider-env';
import { runPiTask, PiTaskTimeoutError } from '../src/lib/harness/pi/task';
import { SPECIALIST_RESULT_CONTRACT } from '../src/lib/agent/result-contract';

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

const work = mkdtempSync(join(tmpdir(), 'opentalon-pi-task-'));
const fakePi = join(__dirname, 'fixtures', 'pi', 'fake-pi.mjs');
const binary = join(work, 'pi');
writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`);
chmodSync(binary, 0o755);

const config: PiHarnessConfig = { enabled: true, binary, trustProject: false, args: [], sessionDir: join(work, 'sessions') };

let runs = 0;
/** A fake pi's options, passed through each model's env, and the file it logs to. */
function fake(options: Record<string, unknown>): { env: Record<string, string>; log: string } {
  const log = join(work, `fake-${++runs}.log`);
  return { env: { FAKE_PI: JSON.stringify({ log, ...options }) }, log };
}

type Logged = { argv?: string[]; pid?: number; command?: Record<string, unknown> };
function logged(log: string): Logged[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

async function until(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (cause) {
    return cause as Error;
  }
}

const ANSWER = 'Changed the greeting.\n\n## Result\nUpdated greet() in /work/src/app.ts.';

async function main(): Promise<void> {
  console.log('=== Provider keys and prompt ===\n');
  ok('anthropic\'s key goes to ANTHROPIC_API_KEY', JSON.stringify(piProviderEnv('anthropic', 'k')) === '{"ANTHROPIC_API_KEY":"k"}');
  ok('google\'s key goes to GEMINI_API_KEY, which pi reads', JSON.stringify(piProviderEnv('google', 'k')) === '{"GEMINI_API_KEY":"k"}');
  ok('a known provider with no key hands over nothing', JSON.stringify(piProviderEnv('openai', undefined)) === '{}');
  ok('a custom provider cannot be handed to pi', piProviderEnv('groq-custom', 'k') === undefined);
  const prompt = buildHarnessSystemPrompt({ soul: 'You are Coder.', contextSnapshot: 'The repo is a Next.js app.' });
  ok('the harness prompt carries the soul and the supervisor context', prompt.includes('## Agent Soul\nYou are Coder.') && prompt.includes('## Context from Supervisor\nThe repo is a Next.js app.'));
  ok('…and ends with the Result Contract native specialists get, verbatim', prompt.endsWith(SPECIALIST_RESULT_CONTRACT.join('\n')));

  console.log('\n=== A task, start to end ===\n');
  {
    const { env, log } = fake({ captures: ['tool-turn'], say: ANSWER });
    const result = await runPiTask({ task: 'Change the greeting.', systemPrompt: 'SYSTEM', models: [{ model: 'stub/stub-model', env }], cwd: work, id: 'spec-1', config });
    ok('the result is pi\'s final answer', result.text === `All done. ${ANSWER}`, result.text);
    ok('…on the model that ran it', result.modelUsed === 'stub/stub-model');
    const argv = logged(log)[0]?.argv ?? [];
    const at = argv.indexOf('--append-system-prompt');
    ok('the system prompt goes to pi as a file, after the harness arguments', at > 0 && argv[at + 1] === join(config.sessionDir, '.prompts', 'spec-1.md'), argv);
    ok('…which is removed afterwards', !existsSync(join(config.sessionDir, '.prompts', 'spec-1.md')));
    ok('the task is the prompt', logged(log).some((entry) => entry.command?.type === 'prompt' && entry.command.message === 'Change the greeting.'));
    ok('pi is stopped once the task is done', !alive(logged(log)[0]?.pid));
  }

  console.log('\n=== Models ===\n');
  {
    const refusedPi = fake({});
    const acceptingPi = fake({ captures: ['tool-turn'], say: ANSWER });
    const result = await runPiTask({
      task: 'Change the greeting.', systemPrompt: 'SYSTEM', cwd: work, config,
      models: [{ model: 'stub/nope', env: refusedPi.env }, { model: 'stub/stub-model', env: acceptingPi.env }],
    });
    ok('a model pi refuses at startup gives way to the next', result.modelUsed === 'stub/stub-model' && result.text.endsWith(ANSWER), result);
    ok('…and the refused process is stopped', !alive(logged(refusedPi.log)[0]?.pid));
  }
  {
    const error = await rejection(runPiTask({
      task: 'x', systemPrompt: 'SYSTEM', cwd: work, config,
      models: [{ model: 'stub/nope', env: fake({}).env }, { model: 'stub/gone', env: fake({}).env }],
    }));
    ok('when pi refuses every model, the error names each one',
      !!error && /accepted none of the models: stub\/nope: .*Model not found.*; stub\/gone: .*Model not found/.test(error.message), error?.message);
  }

  console.log('\n=== Stopping and failing ===\n');
  {
    const { env, log } = fake({ captures: ['abort'], scale: 0.5 });
    const controller = new AbortController();
    const running = runPiTask({ task: 'Run the slow thing.', systemPrompt: 'THE SYSTEM PROMPT', models: [{ model: 'stub/stub-model', env }], cwd: work, id: 'spec-abort', signal: controller.signal, config });
    await until(() => logged(log).some((entry) => entry.command?.type === 'prompt'));
    ok('pi reads the system prompt from the file while it runs', readFileSync(join(config.sessionDir, '.prompts', 'spec-abort.md'), 'utf8') === 'THE SYSTEM PROMPT');
    controller.abort();
    const error = await rejection(running);
    ok('aborting the signal rejects with an AbortError, as a native cancel does', error?.name === 'AbortError', error?.message);
    ok('…after pi was told to abort', logged(log).some((entry) => entry.command?.type === 'abort'));
    ok('…and pi is stopped', !alive(logged(log)[0]?.pid));
  }
  {
    const { env, log } = fake({ captures: ['abort'], scale: 0.5 });
    const error = await rejection(runPiTask({ task: 'Run the slow thing.', systemPrompt: 'S', models: [{ model: 'stub/stub-model', env }], cwd: work, timeoutMs: 1_000, config }));
    ok('a timeout stops pi and rejects with the specialist timeout message',
      error instanceof PiTaskTimeoutError && error.message === 'Specialist timed out after 1s' && logged(log).some((entry) => entry.command?.type === 'abort'), error?.message);
    ok('…and pi is stopped', !alive(logged(log)[0]?.pid));
  }
  {
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(runPiTask({ task: 'x', systemPrompt: 'S', models: [{ model: 'stub/stub-model', env: fake({}).env }], cwd: work, signal: controller.signal, config }));
    ok('a task cancelled before it starts never starts pi', error?.name === 'AbortError');
  }
  {
    const { env } = fake({ captures: ['tool-turn'], exitAfter: 'tool_execution_start' });
    const error = await rejection(runPiTask({ task: 'x', systemPrompt: 'S', models: [{ model: 'stub/stub-model', env }], cwd: work, config }));
    ok('pi dying mid-run fails the task, saying how pi exited', !!error && /^pi failed: pi exited \(code 7\)/.test(error.message), error?.message);
  }
  {
    const error = await rejection(runPiTask({ task: 'x', systemPrompt: 'S', models: [{ model: 'stub/stub-model', env: {} }], cwd: work, config: { ...config, enabled: false } }));
    ok('a disabled harness says how to enable it', error?.message === 'The pi harness is not enabled: set harness.pi.enabled: true in config.yaml', error?.message);
  }
  {
    const error = await rejection(runPiTask({ task: 'x', systemPrompt: 'S', models: [{ model: 'stub/stub-model', env: {} }], cwd: work, config: { ...config, binary: join(work, 'no-such-pi') } }));
    ok('a missing pi says how to install it', !!error && /^pi is not usable: .*not installed or not on the PATH \(npm install -g @earendil-works\/pi-coding-agent\)/.test(error.message), error?.message);
  }
  {
    const error = await rejection(runPiTask({ task: 'x', systemPrompt: 'S', models: [], cwd: work, config }));
    ok('no model at all is a clear error', !!error && /^No model to run pi with/.test(error.message), error?.message);
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
