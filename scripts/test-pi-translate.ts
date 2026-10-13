/**
 * The pi frame translator (#67), against real pi 1.1 sessions recorded in scripts/fixtures/pi/.
 * Assertions ported from edkief/ralph@82dc5a5 test/pi-translate.test.ts.
 *
 * Run: pnpm test:pi-translate
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessEventSchema, isActivityEvent, type EventOf, type HarnessEvent } from '../src/lib/harness/events';
import { FrameSchema } from '../src/lib/harness/pi/frames';
import { PiTranslator } from '../src/lib/harness/pi/translate';

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

/** The frames pi wrote in a recorded session, in order. */
function frames(name: string) {
  return readFileSync(join(__dirname, 'fixtures', 'pi', `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; line: Record<string, unknown> })
    .filter((record) => record.dir === 'out' && record.line['type'] !== 'response')
    .map((record) => FrameSchema.parse(record.line));
}

/** A recorded session translated: pi's own `agent_settled` ends each turn. */
function translate(name: string): HarnessEvent[] {
  const translator = new PiTranslator('s1', { now: () => 1000 });
  return frames(name).flatMap((frame) => translator.push(frame));
}

/** The events of a session's last turn: the overflow sessions open with a turn that builds up a history. */
function lastTurn(events: HarnessEvent[]): HarnessEvent[] {
  return events.slice(events.findLastIndex((event) => event.type === 'prompt.queued'));
}

const ofType = <T extends HarnessEvent['type']>(events: HarnessEvent[], type: T) =>
  events.filter((event): event is EventOf<T> => event.type === type);
const types = (events: HarnessEvent[]) => events.map((event) => event.type);
const frame = (value: Record<string, unknown>) => FrameSchema.parse(value);

console.log('=== A turn with a tool call (tool-turn) ===\n');
{
  const events = translate('tool-turn');
  ok('every event is in the vocabulary, tagged with its session and time',
    events.every((event) => HarnessEventSchema.safeParse(event).success && event.session === 's1' && event.created === 1000));

  const shape = types(events).filter((type) => type !== 'activity' && !type.endsWith('.delta'));
  ok('follows the turn as pi ran it: the model call ends before the tool it asked for runs', same(shape, [
    'prompt.queued', 'step.started', 'tool.started', 'reasoning.ended', 'text.ended', 'step.streamed', 'step.ended',
    'tool.called', 'tool.finished', 'step.started', 'text.ended', 'step.streamed', 'step.ended', 'execution.ended',
  ]), shape);
  ok('the prompt is reported', ofType(events, 'prompt.queued')[0]?.text === 'Run echo hello then finish.');
  ok('a model call names its model as provider/id', ofType(events, 'step.started')[0]?.model === 'stub/stub-model');

  const [delta] = ofType(events, 'text.delta');
  const [textEnded] = ofType(events, 'text.ended');
  ok('deltas and the end of a block share one part id', delta?.part !== undefined && delta.part === textEnded?.part);
  ok('the finished text block carries its text', textEnded?.text === 'Running a command. ', textEnded);
  ok('reasoning is reported', ofType(events, 'reasoning.ended')[0]?.text === 'I should run echo.');

  ok('the tool is named by the id its call started with', same(ofType(events, 'tool.started')[0], { type: 'tool.started', id: 'call_1', name: 'bash', created: 1000, session: 's1' }));
  const [called] = ofType(events, 'tool.called');
  ok('the call reports its input', called?.id === 'call_1' && called.name === 'bash' && same(called.input, { command: 'echo hello && echo oops >&2; exit 3' }), called);
  const [finished] = ofType(events, 'tool.finished');
  ok('a bash call that ran and exited non-zero is success with its exit code', finished?.status === 'success' && finished.exit === 3, finished);
  ok('the tool output is kept', !!finished?.output?.includes('hello') && /Command exited with code 3$/.test(finished.output ?? ''));

  const steps = ofType(events, 'step.ended');
  ok('usage as pi counts it: input without the cached part, thinking inside output',
    same(steps[0]?.usage, { input: 1134, output: 56, reasoning: 0, cacheRead: 100, cacheWrite: 0, cost: 0 }), steps[0]?.usage);
  ok('each model call reports its own usage', steps[1]?.usage.input === 1400 && steps[1].usage.output === 9, steps[1]?.usage);
  ok('finish reasons use the AI SDK names', same(steps.map((step) => step.finish), ['tool-calls', 'stop']));
  const ended = ofType(events, 'execution.ended');
  ok('ends once, as succeeded, as the last event', ended.length === 1 && ended[0].outcome === 'succeeded' && events.at(-1)?.type === 'execution.ended');
}

console.log('\n=== The end of a turn ===\n');
{
  const events = translate('retry');
  const retries = ofType(events, 'retry');
  ok('provider retries are reported with attempt and status',
    same(retries.map((retry) => [retry.attempt, retry.status]), [[1, 500], [2, 500], [3, 500]]) && /^500: .*stub overloaded/.test(retries[0]?.error ?? ''), retries);
  ok('the failed attempts are the retries, not failed steps', ofType(events, 'step.failed').length === 0);
  const [ended] = ofType(events, 'execution.ended');
  ok('retries that run out fail the execution with the provider error', ended?.outcome === 'failed' && /^500: .*stub overloaded/.test(ended.error ?? ''), ended);
  const firstRetry = events.findIndex((event) => event.type === 'retry');
  const between = events.slice(firstRetry + 1, events.findLastIndex((event) => event.type === 'retry'));
  ok('nothing between retries counts as a sign of life', between.filter(isActivityEvent).length === 0);
}
{
  const events = lastTurn(translate('overflow'));
  const [ended] = ofType(events, 'execution.ended');
  ok('an overflow pi could not recover from fails, with an error', ended?.outcome === 'failed' && !!ended.error, ended);
  ok('…after one failed call and a compaction that did not complete',
    ofType(events, 'step.failed').length === 1 && ofType(events, 'compaction.started').length === 1 && ofType(events, 'compaction.ended').length === 0);
}
{
  const events = lastTurn(translate('overflow-recovered'));
  ok('an overflow recovered by compacting shows the compaction',
    same(types(events).filter((type) => type.startsWith('compaction')), ['compaction.started', 'compaction.ended']));
  const ended = ofType(events, 'execution.ended');
  ok('…and ends once, as succeeded', ofType(events, 'step.failed').length === 1 && ended.length === 1 && ended[0].outcome === 'succeeded' && events.at(-1)?.type === 'execution.ended');
}
{
  const events = translate('abort');
  ok('an aborted turn ends aborted', same(ofType(events, 'execution.ended').map((event) => event.outcome), ['aborted']));
  ok('…with no failed call, and the call before the abort counted', ofType(events, 'step.failed').length === 0 && ofType(events, 'step.ended').length === 1);
  ok('…and the tool it cut short as an error', ofType(events, 'tool.finished')[0]?.status === 'error');
}
{
  const events = translate('compact');
  ok('a compaction after the turn does not end it again', ofType(events, 'execution.ended').length === 1);
  ok('…and is reported', same(types(events).slice(-2), ['compaction.started', 'compaction.ended']));
}
{
  const events = translate('steer');
  ok('a steered turn reports both prompts', same(ofType(events, 'prompt.queued').map((event) => event.text), ['Run the slow thing.', 'Wrap up now.']));
  ok('…and settles once, as succeeded', same(ofType(events, 'execution.ended').map((event) => event.outcome), ['succeeded']));
}

console.log('\n=== Settling ===\n');
{
  for (const stopReason of ['error', 'stop']) {
    const translator = new PiTranslator('s');
    translator.push(frame({ type: 'agent_start' }));
    const atEnd = translator.push(frame({ type: 'agent_end', messages: [{ role: 'assistant', stopReason, errorMessage: 'boom' }] }));
    const stillRunning = translator.running;
    const settled = translator.push(frame({ type: 'agent_settled', aborted: false }));
    ok(`agent_end (${stopReason}) does not end the execution; agent_settled does`,
      atEnd.length === 0 && stillRunning && settled.length === 1 && settled[0].type === 'execution.ended' &&
        settled[0].outcome === (stopReason === 'error' ? 'failed' : 'succeeded') && !translator.running, settled);
  }
}
{
  const translator = new PiTranslator('s');
  translator.push(frame({ type: 'agent_start' }));
  translator.push(frame({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] }));
  const settled = translator.push(frame({ type: 'agent_settled', aborted: true }));
  ok('a settle pi marks aborted ends the execution aborted', settled[0]?.type === 'execution.ended' && settled[0].outcome === 'aborted');
  ok('a settle with no run under way is ignored', new PiTranslator('s').push(frame({ type: 'agent_settled', aborted: false })).length === 0);
}
{
  const translator = new PiTranslator('s');
  translator.push(frame({ type: 'agent_start' }));
  const exited = translator.exited('pi exited (code 1)');
  ok('a running turn ends as failed when the process dies',
    exited.length === 1 && exited[0].type === 'execution.ended' && exited[0].outcome === 'failed' && exited[0].error === 'pi exited (code 1)', exited);
  ok('…once', translator.exited('again').length === 0);
}
{
  const translator = new PiTranslator('s');
  const events = [
    { type: 'agent_start' },
    { type: 'tool_execution_start', toolCallId: 'a', toolName: 'write', args: { path: 'src/a.ts' } },
    { type: 'tool_execution_end', toolCallId: 'a', toolName: 'write', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
    { type: 'tool_execution_start', toolCallId: 'b', toolName: 'edit', args: { path: 'src/b.ts' } },
    { type: 'tool_execution_end', toolCallId: 'b', toolName: 'edit', result: { content: [] }, isError: true },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 2, cost: { total: 0.5 } } } },
  ].flatMap((value) => translator.push(frame(value)));
  const [step] = ofType(events, 'step.ended');
  ok('the files a turn wrote (successfully) go to the model call that follows them, with its cost',
    same(step?.files, ['src/a.ts']) && step?.usage.cost === 0.5, step);
}

console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
