/**
 * Pure dashboard state helpers from epic #80:
 *   - #87: a fetched history page's stored status wins over a stale "running".
 *   - #88: model dropdown options always include the agent's own model.
 *
 * Run with: pnpm test:dashboard-state
 */
import { modelOptions } from '../src/app/dashboard/agents/model-options';
import { mergeHistoryPage } from '../src/app/dashboard/orchestration/merge-history';
import type { SpecialistRecord } from '../src/app/dashboard/orchestration/merge-history';
import type { SpecialistSummary, StepEvent } from '../src/lib/agent/log-bus';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}`);
}

function summary(id: string, status: SpecialistSummary['status'], extra: Partial<SpecialistSummary> = {}): SpecialistSummary {
  return { specialistId: id, parentSessionId: 'chat', taskDescription: `task ${id}`, status, spawnedAt: '2026-11-08T00:00:00Z', ...extra };
}
const step = { id: 's1' } as unknown as StepEvent;

console.log('#87 history merge');
{
  const prev = new Map<string, SpecialistRecord>([
    ['stale', { ...summary('stale', 'running'), steps: [step] }],
    ['live', { ...summary('live', 'running', { result: 'live view' }), steps: [step] }],
    ['offpage', { ...summary('offpage', 'running'), steps: [] }],
    ['done', { ...summary('done', 'complete'), steps: [] }],
  ]);
  const next = mergeHistoryPage(prev, [
    summary('stale', 'max_steps', { result: 'stopped at the limit' }),
    summary('live', 'running', { result: 'server view' }),
    summary('fresh', 'error'),
  ]);

  ok('a run that finished unseen shows its stored status', next.get('stale')?.status === 'max_steps');
  ok('and its stored result', next.get('stale')?.result === 'stopped at the limit');
  ok('its loaded steps are kept', next.get('stale')?.steps.length === 1);
  ok('a run still running keeps the live entry', next.get('live')?.result === 'live view' && next.get('live')?.steps.length === 1);
  ok('a running run off the fetched page stays', next.get('offpage')?.status === 'running');
  ok('a finished run off the fetched page is dropped (as before)', !next.has('done'));
  ok('a new run from the page is added with no steps', next.get('fresh')?.status === 'error' && next.get('fresh')?.steps.length === 0);
  ok('prev is not mutated', prev.get('stale')?.status === 'running');
}

console.log('#88 model dropdown options');
{
  const available = ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o'];

  const listed = modelOptions(available, 'openai/gpt-4o');
  ok('a listed model adds nothing', listed.length === 2 && listed.every((o) => o.label === o.value));

  ok('inherit (empty) adds nothing', modelOptions(available, '').length === 2);

  const own = modelOptions(available, 'minimax/MiniMax-M3');
  ok('an unlisted model is added first', own[0]?.value === 'minimax/MiniMax-M3');
  ok('and marked as not in the list', own[0]?.label === 'minimax/MiniMax-M3 (not in list)');
  ok('the listed models follow', own.length === 3 && own[1].value === available[0]);

  const none = modelOptions([], 'minimax/MiniMax-M3');
  ok('shown even when no models are detected', none.length === 1 && none[0].value === 'minimax/MiniMax-M3');
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
