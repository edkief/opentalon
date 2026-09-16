/**
 * Regression checks for the todo_update loop fix (#55).
 *
 * Two independent conditions let a weaker model loop forever on the same
 * `todo_update` call, and this covers both:
 *   1. the volatile system block (Active Todos) was a turn-start snapshot that
 *      never refreshed during the multi-step loop, so it contradicted the tool
 *      history it was sitting next to;
 *   2. `todo_update` was a silent idempotent no-op — same input, byte-identical
 *      output, no signal that nothing had happened.
 *
 * Run with: pnpm test:todo-loop
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelMessage } from 'ai';
import { buildVolatileSystem, makeVolatileRefresh } from '../src/lib/agent/volatile-system';
import { todoManager } from '../src/lib/agent/todo-manager';
import { getTodoTools } from '../src/lib/tools/todos';
import { configManager } from '../src/lib/config/config-manager';

// getWorkspaceDir() resolves config-then-env at call time, so pointing both at
// a scratch dir keeps the checks off the real workspace's todo files.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-loop-'));
process.env.AGENT_WORKSPACE = WORKSPACE;
const cfg = configManager.get();
cfg.tools = { ...(cfg.tools ?? {}), agentWorkspace: WORKSPACE };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

const SCOPE = 'test-chat';
const tools = getTodoTools({ todoScopeId: SCOPE });

// The AI SDK types execute() loosely; these helpers keep the calls readable.
type Exec = (input: unknown, opts: unknown) => Promise<string>;
const call = (name: string, input: unknown) =>
  (tools[name].execute as unknown as Exec)(input, {});

async function main(): Promise<void> {
  console.log('\n[1] todo_update reports a no-op instead of repeating "Task updated."');

  await call('todo_create', { goal: 'Ship the fix', todos: ['first task', 'second task'] });
  const created = todoManager.load(SCOPE)!;
  const firstId = created.todos[0].id.slice(0, 8);

  const realUpdate = await call('todo_update', { id: firstId, done: true });
  ok('a real change still reports "Task updated."', realUpdate.startsWith('Task updated.'));
  ok('the change is persisted', todoManager.load(SCOPE)!.todos[0].done === true);

  const savedAt = todoManager.load(SCOPE)!.updatedAt;
  const repeat = await call('todo_update', { id: firstId, done: true });
  ok('re-marking a done task does NOT report "Task updated."', !repeat.startsWith('Task updated.'));
  ok('the no-op is named as such', repeat.includes('No change:'));
  ok('the response tells the model to stop repeating', repeat.includes('Do not repeat this call'));
  ok('the response names the next action', repeat.includes('still pending'));
  ok('a real update and a no-op produce different output', realUpdate !== repeat);
  ok('the no-op does not rewrite updatedAt', todoManager.load(SCOPE)!.updatedAt === savedAt);

  console.log('\n[2] The no-op response steers to todo_clear once nothing is pending');

  const secondId = created.todos[1].id.slice(0, 8);
  await call('todo_update', { id: secondId, done: true });
  const allDone = await call('todo_update', { id: secondId, done: true });
  ok('suggests todo_clear when every item is done', allDone.includes('todo_clear'));
  ok('does not claim items are pending', !allDone.includes('still pending'));

  console.log('\n[3] Real edits are still detected as changes, not swallowed as no-ops');

  const retext = await call('todo_update', { id: secondId, done: true, text: 'renamed task' });
  ok('a text change on an already-done task is a real update', retext.startsWith('Task updated.'));
  ok('the new text is persisted', todoManager.load(SCOPE)!.todos[1].text === 'renamed task');

  const undone = await call('todo_update', { id: secondId, done: false, waiting_on_job_id: 'job-1234abcd' });
  ok('un-marking + delegating is a real update', undone.startsWith('Task updated.'));
  const relink = await call('todo_update', { id: secondId, done: false, waiting_on_job_id: 'job-1234abcd' });
  ok('re-linking the same job is a no-op', relink.includes('No change:'));

  console.log('\n[4] The volatile system block re-renders per step');

  todoManager.save(SCOPE, {
    goal: 'Ship the fix',
    todos: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', text: 'pending item', done: false },
    ],
  });

  const initialVolatile = await buildVolatileSystem(SCOPE);
  ok('the initial block shows the item as pending', initialVolatile.includes('- [ ] pending item'));

  const stable: ModelMessage = { role: 'system', content: 'STABLE BLOCK' };
  const messages: ModelMessage[] = [
    stable,
    { role: 'system', content: initialVolatile },
    { role: 'user', content: 'do the thing' },
  ];

  const refresh = makeVolatileRefresh(initialVolatile, SCOPE);
  ok('no rewrite while nothing has changed', (await refresh(messages)) === undefined);

  // Simulate the model marking the item done mid-turn.
  const list = todoManager.load(SCOPE)!;
  list.todos[0].done = true;
  todoManager.save(SCOPE, list);

  const rewritten = await refresh(messages);
  ok('the message list is rewritten once state changes', rewritten !== undefined);
  ok('the refreshed block shows the item as done', String(rewritten![1].content).includes('- [x] pending item'));
  ok('it no longer shows the stale unchecked line', !String(rewritten![1].content).includes('- [ ] pending item'));
  ok('the stable system message is untouched (prompt cache intact)', rewritten![0] === stable);
  ok('non-system messages are preserved', rewritten![2] === messages[2]);
  ok('the original array is not mutated', messages[1].content === initialVolatile);

  // The refresher tracks what it last emitted, so it keeps finding its target on
  // later steps even though the caller's array no longer matches the initial text.
  const list2 = todoManager.load(SCOPE)!;
  list2.todos.push({ id: 'bbbbbbbb-0000-0000-0000-000000000000', text: 'added mid-turn', done: false });
  todoManager.save(SCOPE, list2);
  const rewrittenAgain = await refresh(rewritten!);
  ok('a later step refreshes again', rewrittenAgain !== undefined);
  ok('the second refresh picks up the newly added item', String(rewrittenAgain![1].content).includes('added mid-turn'));

  ok('an unrecognised message list is left alone', (await refresh([stable, { role: 'user', content: 'x' }])) === undefined);

  console.log('\n[5] The generation call sites wire the refresh in');

  const EXECUTOR_SOURCE = fs.readFileSync(path.join(ROOT, 'src/lib/agent/llm-executor.ts'), 'utf8');
  ok('main turn prepareStep applies it', /prepareStep: async \(\{ messages \}[\s\S]{0,400}refreshVolatile\(messages\)/.test(EXECUTOR_SOURCE));
  ok('finalise turn applies it', /finaliseToolOptions = \{[\s\S]{0,400}refreshVolatile\(messages\)/.test(EXECUTOR_SOURCE));
  ok('todo-check rebuilds its own volatile block', EXECUTOR_SOURCE.includes('const todoCheckVolatile = await buildVolatileSystem(chatId)'));
  ok('todo-check no longer forwards the stale fullMessages[1]', !EXECUTOR_SOURCE.includes('fullMessages[1],'));

  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed\n`);
    process.exit(1);
  }
  console.log('\nAll checks passed\n');
}

main();
