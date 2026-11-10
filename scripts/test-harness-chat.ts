/**
 * Agents with `executor: pi` run in pi when talked to directly (#93): the direct-chat prompt and
 * transcript, and LLMExecutor.chat() handing the whole turn to pi (the fake pi in
 * scripts/fixtures/pi/), with no fall back to the native loop when pi cannot run.
 *
 * Run: pnpm test:harness-chat
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = __dirname;

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

// The agent registry reads the workspace when it loads, so it is set up before any import of it.
const work = mkdtempSync(join(tmpdir(), 'opentalon-harness-chat-'));
process.env.AGENT_WORKSPACE = work;
for (const [id, yml] of [
  ['coder', 'model: anthropic/stub-model\nexecutor: pi\n'],
  ['plain', 'model: anthropic/stub-model\n'],
]) {
  mkdirSync(join(work, 'agents', id), { recursive: true });
  writeFileSync(join(work, 'agents', id, 'AGENT.md'), `# ${id}\n\nYou are ${id}.\n`);
  writeFileSync(join(work, 'agents', id, 'agent.yml'), yml);
}
const binary = join(work, 'pi');
writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${join(here, 'fixtures', 'pi', 'fake-pi.mjs')}" "$@"\n`);
chmodSync(binary, 0o755);
process.env.ANTHROPIC_API_KEY = 'test-key';

const ANSWER = 'Changed the greeting in src/app.ts.';

// Steps are persisted fire-and-forget; with no database here that only logs. Keep the output readable.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[orchestration-store]')) return;
  consoleError(...args);
};

async function main(): Promise<void> {
  const { buildHarnessChatPrompt, renderTranscript } = await import('../src/lib/harness/pi/prompt');
  const { SPECIALIST_RESULT_CONTRACT } = await import('../src/lib/agent/result-contract');

  console.log('=== The direct-chat prompt ===\n');
  {
    const prompt = buildHarnessChatPrompt({
      soul: 'You are Coder.',
      coreMemory: 'User prefers metric units.',
      context: 'Telegram chat_id: 42.',
      recalledNotes: 'The repo is a Next.js app.',
      transcript: '### User\nhi',
    });
    ok('it says pi is talking with the user and its last message is the reply', prompt.startsWith('## Role\nYou are an OpenTalon agent, talking with the user directly.'));
    ok('it carries the soul, Core Memory, context, notes and conversation',
      ['## Agent Soul\nYou are Coder.', '## Core Memory (read-only)\nUser prefers metric units.', '## Context\nTelegram chat_id: 42.',
        '## Recalled notes\nThe repo is a Next.js app.', '## Conversation so far\n### User\nhi'].every((part) => prompt.includes(part)), prompt);
    ok('…and not the specialist Result Contract', !prompt.includes(SPECIALIST_RESULT_CONTRACT[0]));
    ok('a first message says so', buildHarnessChatPrompt({}).endsWith('## Conversation so far\n(this is the first message)'));
  }

  console.log('\n=== The transcript ===\n');
  {
    const history = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'system', content: 'not shown' },
      { role: 'user', content: '  ' },
      { role: 'user', content: 'second question' },
    ];
    ok('messages are labelled, in order, without system or empty ones',
      renderTranscript(history) === '### User\nfirst question\n\n### You\nfirst answer\n\n### User\nsecond question', renderTranscript(history));
    const cut = renderTranscript(history, 40);
    ok('over the limit, the newest are kept and the rest are counted', cut === '(2 earlier messages left out)\n\n### User\nsecond question', cut);
    ok('no history is an empty transcript', renderTranscript([]) === '');
  }

  const { configManager } = await import('../src/lib/config/config-manager');
  const cfg = configManager.get();
  cfg.tools = { ...(cfg.tools ?? {}), agentWorkspace: work };
  cfg.memory = { ...(cfg.memory ?? {}), enabled: false };
  const setPi = (enabled: boolean) => {
    cfg.harness = { pi: { enabled, binary, sessionDir: join(work, 'sessions') } };
  };
  const { isHarnessAgent, runHarnessChat } = await import('../src/lib/agent/harness-run');
  const { logBus } = await import('../src/lib/agent/log-bus');
  type Step = { turnId?: string; phase?: string; agentId?: string; harness?: string; specialistId?: string; systemPrompt?: string; stage?: string };
  const steps: Step[] = [];
  logBus.on('step', (event: Step) => steps.push(event));
  const fakePi = (extra: Record<string, unknown> = {}) => {
    process.env.FAKE_PI = JSON.stringify({ captures: ['tool-turn'], say: ANSWER, models: [{ provider: 'anthropic', id: 'stub-model' }], ...extra });
  };

  console.log('\n=== A direct turn of a pi agent ===\n');
  {
    setPi(true);
    fakePi();
    steps.length = 0;
    const result = await runHarnessChat({
      agentId: 'coder',
      chatId: 'chat-1',
      turnId: 'turn-1',
      messages: [
        { role: 'user', content: 'What does the app do?' },
        { role: 'assistant', content: 'It greets people.' },
        { role: 'user', content: 'Change the greeting.' },
      ],
      context: 'Telegram chat_id: chat-1.',
    });
    ok('the reply is pi\'s final answer', result.text.endsWith(ANSWER), result.text);
    ok('…on the model pi ran', result.modelUsed === 'anthropic/stub-model', result.modelUsed);
    ok('…with pi\'s usage added up', result.usage.output === 65, result.usage);
    const turnSteps = steps.filter((s) => s.turnId === 'turn-1' && !s.stage);
    ok('pi\'s steps are the turn\'s main steps, tagged pi', turnSteps.length === 2
      && turnSteps.every((s) => s.phase === 'main' && s.agentId === 'coder' && s.harness === 'pi' && s.specialistId === undefined), turnSteps);
    const told = turnSteps[0]?.systemPrompt ?? '';
    ok('pi is told the soul, the context and the conversation before the message',
      told.includes('You are coder.') && told.includes('## Context\nTelegram chat_id: chat-1.')
        && told.includes('### User\nWhat does the app do?\n\n### You\nIt greets people.') && !told.includes('Change the greeting.'), told);
  }

  console.log('\n=== A chat model pin and a scheduled run ===\n');
  {
    fakePi();
    steps.length = 0;
    const result = await runHarnessChat({ agentId: 'coder', turnId: 'turn-2', runId: 'run-1', modelOverride: 'anthropic/stub-model', messages: [{ role: 'user', content: 'Go.' }] });
    ok('the pinned model runs', result.modelUsed === 'anthropic/stub-model');
    ok('a run\'s steps carry its id, as natively', steps.filter((s) => s.turnId === 'turn-2' && !s.stage).every((s) => s.specialistId === 'run-1'));
    const refused = await runHarnessChat({ agentId: 'coder', turnId: 'turn-2b', modelOverride: 'custom-provider/x', messages: [{ role: 'user', content: 'Go.' }] })
      .then(() => undefined, (cause: Error) => cause);
    ok('a pinned model pi cannot run is an error, not the agent\'s chain', refused?.message.includes('pi can only run models') === true, refused?.message);
  }

  console.log('\n=== pi cannot run ===\n');
  {
    setPi(false);
    const error = await runHarnessChat({ agentId: 'coder', turnId: 'turn-3', messages: [{ role: 'user', content: 'Go.' }] })
      .then(() => undefined, (cause: Error) => cause);
    ok('a disabled pi is an error that says how to enable it', error?.message.includes('harness.pi.enabled') === true, error?.message);
  }

  console.log('\n=== /cancel stops pi ===\n');
  {
    setPi(true);
    fakePi({ captures: ['abort'], scale: 0.5 });
    const { turnCancellation } = await import('../src/lib/agent/cancellation');
    const turn = turnCancellation.register('chat-2', 'turn-4', undefined, { abortOnGraceful: true });
    const pending = runHarnessChat({ agentId: 'coder', chatId: 'chat-2', turnId: 'turn-4', messages: [{ role: 'user', content: 'Go.' }], signal: turn.signal })
      .then(() => undefined, (cause: Error) => cause);
    await new Promise((r) => setTimeout(r, 1500));
    const asked = turnCancellation.request('chat-2', 'graceful');
    const error = await pending;
    turnCancellation.unregister('chat-2', 'turn-4');
    ok('a graceful /cancel aborts a turn registered with abortOnGraceful', asked.status === 'graceful' && turn.signal.aborted);
    ok('…and pi stops with an AbortError', error?.name === 'AbortError', error);
    const native = turnCancellation.register('chat-3', 'turn-5');
    turnCancellation.request('chat-3', 'graceful');
    ok('a native turn\'s graceful /cancel still only sets the flag', !native.signal.aborted && native.shouldStop());
    turnCancellation.unregister('chat-3', 'turn-5');
  }

  console.log('\n=== LLMExecutor.chat() hands pi agents to pi (source invariants) ===\n');
  {
    // llm-executor.ts can't be loaded by tsx here (an ESM-only MCP package), so, as
    // test-specialist does, its wiring is checked in the source.
    const source = readFileSync(join(here, '..', 'src', 'lib', 'agent', 'llm-executor.ts'), 'utf8');
    const chatBody = source.slice(source.indexOf('  async chat(options: ChatOptions)'));
    const branch = chatBody.indexOf('if (inHarness)');
    ok('chat() decides on isHarnessAgent for every non-specialist turn', /const inHarness = !statelessSpecialist && isHarnessAgent\(agentId\)/.test(chatBody));
    ok('…and branches before any native model is resolved', branch > 0 && branch < chatBody.indexOf('resolveModelList('));
    ok('a pi turn registers its /cancel to abort on graceful', chatBody.includes('{ abortOnGraceful: inHarness }'));
    ok('a failed pi turn is a [Harness] error, with no native fall back in chatInHarness',
      source.includes('`[Harness] This agent runs in pi, and the pi run failed: ${reason}`')
        && !source.slice(source.indexOf('private async chatInHarness'), source.indexOf('  async chat(options: ChatOptions)')).includes('generateText'));
    ok('an agent without executor is not a harness agent', !isHarnessAgent('plain') && isHarnessAgent('coder'));
  }
}

main()
  .catch((err) => {
    failed++;
    console.error(err);
  })
  .finally(() => {
    rmSync(work, { recursive: true, force: true });
    console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
