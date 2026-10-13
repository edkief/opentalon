/**
 * pi runs as thought-stream steps (#69): recorded pi sessions (scripts/fixtures/pi/), translated
 * by PiTranslator and folded by HarnessStepFolder, give the StepEvents a native specialist would.
 *
 * Run: pnpm test:harness-steps
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '../src/lib/harness/events';
import { FrameSchema } from '../src/lib/harness/pi/frames';
import { PiTranslator } from '../src/lib/harness/pi/translate';
import { HarnessStepFolder, usageFields, type FoldedStep } from '../src/lib/agent/harness-steps';
import { TOOL_OUTPUT_LIMIT } from '../src/lib/agent/log-bus';

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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function events(name: string, options: { exitAfter?: number } = {}): HarnessEvent[] {
  const translator = new PiTranslator('s1', { now: () => 1000 });
  const frames = readFileSync(join(__dirname, 'fixtures', 'pi', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; line: Record<string, unknown> })
    .filter((record) => record.dir === 'out' && record.line['type'] !== 'response')
    .map((record) => FrameSchema.parse(record.line));
  const out: HarnessEvent[] = [];
  for (const [index, frame] of frames.entries()) {
    if (options.exitAfter !== undefined && index === options.exitAfter) {
      out.push(...translator.exited('pi exited (code 1)'));
      break;
    }
    out.push(...translator.push(frame));
  }
  return out;
}

function fold(input: HarnessEvent[], progressive = false): FoldedStep[] {
  let clock = 5000;
  const folder = new HarnessStepFolder({ specialistId: 'spec1', threadId: 'thread1', harness: 'pi', progressive, now: () => (clock += 10) });
  return [...input.flatMap((event) => folder.push(event)), ...folder.finish()];
}

const done = (steps: FoldedStep[]) => steps.filter((step) => step.persist).map((step) => step.event);

console.log('=== A turn with a tool call (tool-turn) ===\n');
{
  const steps = done(fold(events('tool-turn')));
  ok('one persisted step per model call', steps.length === 2, steps.length);
  const [first, second] = steps;
  ok('steps are attributed like a native specialist step',
    steps.every((s) => s.sessionId === 'spec1' && s.specialistId === 'spec1' && s.threadId === 'thread1' && s.phase === 'specialist' && s.agentId === undefined && s.harness === 'pi'));
  ok('ids and indexes follow the native progressive scheme',
    same(steps.map((s) => [s.id, s.stepIndex]), [['spec1:specialist:1', 1], ['spec1:specialist:2', 2]]));
  ok('the model is provider/id', first?.model === 'stub/stub-model');
  ok('reasoning and text are kept', first?.reasoning === 'I should run echo.' && first.text === 'Running a command.', first);
  ok('the tool call carries its input', same(first?.toolCalls, [{ toolName: 'bash', input: { command: 'echo hello && echo oops >&2; exit 3' } }]), first?.toolCalls);
  ok('the tool result is on the step that asked for it', first?.toolResults?.length === 1 && first.toolResults[0].toolName === 'bash'
    && first.toolResults[0].output.includes('hello') && first.toolResults[0].isError === undefined, first?.toolResults);
  ok('finish reasons use the AI SDK names', same(steps.map((s) => s.finishReason), ['tool-calls', 'stop']));
  ok('usage in the stored shape: input includes the cached part',
    first?.inputTokens === 1234 && first.outputTokens === 56 && first.cacheReadTokens === 100 && first.cacheWriteTokens === 0 && first.harnessCostUsd === 0, first);
  ok('each step reports its own usage', second?.inputTokens === 1400 && second.outputTokens === 9, second);
  ok('durations are measured', steps.every((s) => typeof s.durationMs === 'number' && s.durationMs >= 0));
  ok('without progressive steps there are no live stages and no stage field', fold(events('tool-turn')).every((s) => s.persist && s.event.stage === undefined));
}

console.log('\n=== Progressive stages ===\n');
{
  const all = fold(events('tool-turn'), true);
  const first = all.filter((s) => s.event.id === 'spec1:specialist:1');
  const stages = first.map((s) => s.event.stage);
  // pi names the tool call while it streams, before its reasoning block ends.
  ok('a step streams responding/thinking → tools → done under one id',
    same(stages, ['responding', 'thinking', 'responding', 'tools', 'tools', 'tools', 'done']), stages);
  ok('only done is persisted', all.every((s) => s.persist === (s.event.stage === 'done')));
  const running = first.find((s) => s.event.stage === 'tools' && !s.event.toolResults);
  ok('a tool shows as running before its result', !!running?.event.toolCalls?.length, running?.event);
  const finished = first.filter((s) => s.event.stage === 'tools').at(-1);
  ok('…and its result arrives before the step is done', finished?.event.toolResults?.length === 1);
}

console.log('\n=== Harness moments ===\n');
{
  const steps = done(fold(events('retry')));
  const retries = steps.filter((s) => s.finishReason === 'retry');
  ok('each provider retry is a step of its own', retries.length === 3 && /attempt 1\): 500: .*stub overloaded/.test(retries[0].text ?? ''), steps.map((s) => s.text));
  ok('the empty failed attempt before the first retry leaves no step', steps[0]?.finishReason === 'retry', steps[0]);
  const last = steps.at(-1);
  ok('retries that run out end in an error step', last?.finishReason === 'error' && /stub overloaded/.test(last.errorMessage ?? ''), last);
  ok('indexes stay contiguous', same(steps.map((s) => s.stepIndex), steps.map((_, i) => i + 1)));
}
{
  const steps = done(fold(events('overflow-recovered')));
  ok('a recovered overflow shows the failed call', steps.some((s) => s.finishReason === 'error' && !!s.errorMessage), steps.map((s) => [s.finishReason, s.errorMessage]));
  ok('…and the compaction', steps.some((s) => s.finishReason === 'compaction'));
  ok('…and no run failure', !steps.some((s) => /^pi run failed/.test(s.text ?? '')));
}
{
  const steps = done(fold(events('overflow')));
  const errors = steps.filter((s) => s.finishReason === 'error');
  ok('an overflow pi could not recover from is visible as an error', errors.length >= 1 && steps.some((s) => s.finishReason === 'compaction'), steps.map((s) => [s.finishReason, s.text]));
}
{
  const steps = done(fold(events('abort')));
  ok('an aborted run ends with an aborted step', steps.at(-1)?.finishReason === 'aborted', steps.map((s) => s.finishReason));
  ok('…and the tool it cut short is an error', steps.some((s) => s.toolResults?.some((r) => r.isError)));
}
{
  // pi dies right after the tool starts.
  const all = events('tool-turn');
  const cut = events('tool-turn', { exitAfter: findFrame('tool-turn', 'tool_execution_start') + 1 });
  ok('(fixture cut where intended)', cut.length < all.length && cut.at(-1)?.type === 'execution.ended');
  const steps = done(fold(cut));
  const last = steps.at(-1);
  ok('pi exiting mid-run is an error step naming the exit', last?.finishReason === 'error' && /pi exited \(code 1\)/.test(last.errorMessage ?? ''), last);
  ok('…after the step it was on, kept with its tool call', steps[0]?.toolCalls?.length === 1 && steps[0].finishReason === 'tool-calls');
}

{
  // An attempt that streamed before failing, retried, then the run fails with the same error.
  const steps = done(fold([
    { type: 'step.started' },
    { type: 'text.delta', text: 'half' },
    { type: 'retry', attempt: 1, error: '500: boom' },
    { type: 'execution.ended', outcome: 'failed', error: '500: boom' },
  ]));
  ok('a retried attempt that got somewhere is kept as an error step', steps[0]?.finishReason === 'error' && steps[0].text === 'half');
  ok('…and the run failure is still its own step', same(steps.map((s) => s.finishReason), ['error', 'retry', 'error']) && /^pi run failed/.test(steps[2]?.text ?? ''), steps.map((s) => [s.finishReason, s.text]));
}

console.log('\n=== Limits and usage ===\n');
{
  const big = 'x'.repeat(TOOL_OUTPUT_LIMIT + 500);
  const steps = done(fold([
    { type: 'step.started', model: 'anthropic/claude' },
    { type: 'tool.started', id: 't1', name: 'bash' },
    { type: 'step.ended', finish: 'tool-calls', usage: { input: 10, output: 5, reasoning: 2, cacheRead: 30, cacheWrite: 7, cost: 0.0123 } },
    { type: 'tool.called', id: 't1', input: { command: 'cat big' } },
    { type: 'tool.finished', id: 't1', status: 'error', output: big },
    { type: 'execution.ended', outcome: 'succeeded' },
  ]));
  const [step] = steps;
  ok('tool output is capped at TOOL_OUTPUT_LIMIT', step?.toolResults?.[0].output.length === TOOL_OUTPUT_LIMIT);
  ok('a tool pi reports as failed is isError, named from its call', step?.toolResults?.[0].isError === true && step.toolResults[0].toolName === 'bash');
  ok('usage and pi cost are mapped', same(
    [step?.inputTokens, step?.outputTokens, step?.cacheReadTokens, step?.cacheWriteTokens, step?.reasoningTokens, step?.harnessCostUsd],
    [47, 5, 30, 7, 2, 0.0123]));
  ok('usageFields leaves reasoning out when not reported', usageFields({ input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }).reasoningTokens === undefined);
}
{
  const steps = done(fold([
    { type: 'step.started' },
    { type: 'text.delta', text: 'partial ans' },
  ]));
  ok('a run cut off before its end keeps the step it was on', steps.length === 1 && steps[0].text === 'partial ans' && steps[0].finishReason === 'aborted', steps);
}

console.log('\n=== Permission gate decisions (#70) ===\n');
{
  // The session reports the gate's events beside the translated frames: after the call, before its result.
  const recorded = events('gate-block');
  const at = recorded.findIndex((event) => event.type === 'tool.called') + 1;
  const reason = 'The user denied run_shell. Do not try another way round it; carry on without it.';
  const withGate: HarnessEvent[] = [
    ...recorded.slice(0, at),
    { type: 'permission.asked', id: 'g1', call: 'call_1', tool: 'bash', input: { command: 'echo hello' } },
    { type: 'permission.decided', id: 'g1', call: 'call_1', tool: 'bash', decision: 'denied', reason },
    ...recorded.slice(at),
  ];
  const steps = done(fold(withGate));
  const call = steps[0]?.toolCalls?.[0];
  ok('the decision is kept on the call it was about', call?.toolName === 'bash' && same(call.permission, { decision: 'denied', reason }), call);
  ok('…and the block reaches the tool result as an error', steps[0]?.toolResults?.[0].isError === true && steps[0].toolResults[0].output.includes('do not allow this'), steps[0]?.toolResults);

  const live = fold(withGate.slice(0, at + 1), true).filter((step) => !step.persist).map((step) => step.event);
  ok('while it waits, the call shows as asked (progressive)', live.at(-1)?.toolCalls?.[0].permission?.decision === 'asked', live.at(-1)?.toolCalls);

  const untied = done(fold([
    ...recorded.slice(0, at),
    { type: 'permission.decided', id: 'g2', tool: 'unknown', decision: 'blocked', reason: 'unreadable' },
    ...recorded.slice(at),
  ]));
  ok('a decision tied to no call changes no call', untied[0]?.toolCalls?.every((c) => c.permission === undefined) === true, untied[0]?.toolCalls);
}

function findFrame(name: string, type: string): number {
  return readFileSync(join(__dirname, 'fixtures', 'pi', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; line: Record<string, unknown> })
    .filter((record) => record.dir === 'out' && record.line['type'] !== 'response')
    .findIndex((record) => record.line['type'] === type);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
