/**
 * Resume for scheduled runs that hit the step limit (#86).
 *
 * Run with: pnpm test:scheduled-resume
 */
import type { ModelMessage } from 'ai';
import {
  CALLBACK_DATA_LIMIT,
  buildResumeHistory,
  buildResumeTaskMessage,
  parseResumeRunData,
  resumeRunData,
  resumeScheduledRun,
  stepLimitKeyboard,
  stepLimitNotice,
  type ResumeDeps,
} from '../src/lib/telegram/scheduled-resume';
import type { SpecialistSummary } from '../src/lib/agent/log-bus';
import type { NewConversation } from '../src/lib/db/schema';
import type { TaskData } from '../src/lib/scheduler';
import { toModelMessages } from '../src/lib/agent/turn-parts';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}`);
}

const RUN_ID = '991a16db-74d3-4f77-a227-c54d6c20bf44';

console.log('callback data');
{
  const data = resumeRunData(RUN_ID, 200);
  ok('fits in Telegram\'s 64 bytes', Buffer.byteLength(data) <= CALLBACK_DATA_LIMIT);
  const parsed = parseResumeRunData(data);
  ok('round-trips', parsed?.runId === RUN_ID && parsed?.steps === 200);
  ok('rejects a missing step count', parseResumeRunData(`resume_run_${RUN_ID}`) === null);
  ok('rejects a zero step count', parseResumeRunData(`resume_run_${RUN_ID}_0`) === null);
  ok('rejects other prefixes', parseResumeRunData(`resume_main_20`) === null);
}

console.log('step-limit keyboard');
{
  type Button = { text: string; callback_data?: string };
  const buttons = (rows: unknown) => (rows as Button[][]).flat();

  const withRun = buttons(stepLimitKeyboard(RUN_ID, 200).inline_keyboard);
  ok('offers 200, 20 and 30 more steps', withRun.filter((b) => b.callback_data?.startsWith('resume_run_')).map((b) => parseResumeRunData(b.callback_data!)?.steps).join(',') === '200,20,30');
  ok('every button fits in 64 bytes', withRun.every((b) => Buffer.byteLength(b.callback_data ?? '') <= CALLBACK_DATA_LIMIT));
  ok('Close task stays', withRun.at(-1)?.callback_data === 'close_main');
  ok('no legacy resume_main buttons', !withRun.some((b) => b.callback_data?.startsWith('resume_main_')));

  const dedup = buttons(stepLimitKeyboard(RUN_ID, 20).inline_keyboard);
  ok('a step limit of 20 isn\'t offered twice', dedup.filter((b) => b.callback_data?.startsWith('resume_run_')).length === 2);

  const heartbeat = buttons(stepLimitKeyboard(undefined, 200).inline_keyboard);
  ok('no run id (heartbeat): Close task only', heartbeat.length === 1 && heartbeat[0].callback_data === 'close_main');
  ok('and the notice says it stopped', /stopped/.test(stepLimitNotice(false)) && /resume/.test(stepLimitNotice(true)));
}

console.log('resume run');
{
  const msg = buildResumeTaskMessage('pull yesterday\'s demo activity');
  ok('task message names the task', msg.includes('Task: pull yesterday\'s demo activity'));
  ok('and says to continue, not redo', /Continue from where you left off/.test(msg) && /Don't redo/.test(msg));

  const parts = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'run_shell', input: { command: 'ls' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'run_shell', output: { type: 'text', value: 'a.log' } }] },
  ] as ModelMessage[];
  const history = buildResumeHistory([
    { role: 'user', content: '[Scheduled Task Triggered] …', parts: null },
    { role: 'assistant', content: '⚠️ Reached the 200-step limit mid-task.', parts },
  ] as NewConversation[]);
  ok('history keeps both rows in order', history.length === 2 && history[0].role === 'user' && history[1].role === 'assistant');
  ok('the user row carries no parts', history[0].parts === undefined);
  const replayed = history.flatMap(toModelMessages);
  ok('the tool call and result are replayed', replayed.length === 4 && replayed[1].role === 'assistant' && replayed[2].role === 'tool');
}

async function main(): Promise<void> {
console.log('resumeScheduledRun');
{
  const run = (over: Partial<SpecialistSummary> = {}): SpecialistSummary => ({
    specialistId: RUN_ID, parentSessionId: 'chat-1', taskDescription: 'demo activity', status: 'max_steps',
    spawnedAt: '2026-11-08T00:00:00Z', agentId: 'dataminer', turnId: 'turn-1', ...over,
  });
  const scheduled: Array<{ chatId: string; description: string; extra: Partial<TaskData> }> = [];
  const deps = (r: SpecialistSummary | null, rows: Partial<NewConversation>[] = [{ role: 'user', content: 'x', threadId: 'thread-9' }]): ResumeDeps => ({
    getRun: async () => r,
    getTurn: async () => rows as NewConversation[],
    scheduleOnce: async (_id, chatId, description, _delay, extra) => { scheduled.push({ chatId, description, extra }); return 'job'; },
  });

  const res = await resumeScheduledRun('chat-1', RUN_ID, 30, deps(run()));
  const s = scheduled.at(-1);
  ok('resumes a stopped run', res.ok && scheduled.length === 1);
  ok('same chat, same task', s?.chatId === 'chat-1' && s?.description === 'demo activity');
  ok('same agent, its thread, the extra steps', s?.extra.agentId === 'dataminer' && s?.extra.threadId === 'thread-9' && s?.extra.maxSteps === 30);
  ok('and points at the run it resumes', s?.extra.resumeOfRunId === RUN_ID);

  await resumeScheduledRun('chat-1', RUN_ID, 30, deps(run({ agentId: undefined })));
  ok('a default-agent run resumes as default', scheduled.at(-1)?.extra.agentId === 'default');

  const before = scheduled.length;
  const wrongChat = await resumeScheduledRun('chat-2', RUN_ID, 30, deps(run()));
  const gone = await resumeScheduledRun('chat-1', RUN_ID, 30, deps(null));
  const finished = await resumeScheduledRun('chat-1', RUN_ID, 30, deps(run({ status: 'complete' })));
  const noTurn = await resumeScheduledRun('chat-1', RUN_ID, 30, deps(run({ turnId: undefined })));
  const cleared = await resumeScheduledRun('chat-1', RUN_ID, 30, deps(run(), []));
  ok('another chat\'s run is refused', !wrongChat.ok);
  ok('a missing run is refused', !gone.ok);
  ok('a run no longer at its limit is refused, with its status', !finished.ok && finished.reason.includes('complete'));
  ok('a run with no turn is refused', !noTurn.ok);
  ok('a run whose conversation was cleared is refused', !cleared.ok);
  ok('nothing is queued for a refused resume', scheduled.length === before);
}
}

main().then(() => {
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
process.exit(0);
});
