import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { todoManager } from '../agent/todo-manager';
import type { BuiltInToolsOpts } from './types';

export function getTodoTools(opts?: BuiltInToolsOpts): ToolSet {
  // Todos are keyed by an explicit scope id so each execution context (main agent
  // = chatId, each specialist = its own specialistId) gets an isolated list.
  const scopeId = opts?.todoScopeId ?? opts?.chatId;
  if (!scopeId) return {};

  return {
    todo_create: tool({
      description:
        'Clear the existing todo list and start a new one with a high-level goal and tasks. ' +
        'Use this at the start of any multi-step or non-trivial task.',
      inputSchema: z.object({
        goal: z.string().describe('High-level goal for this task, e.g. "Fix authentication bug"'),
        todos: z.array(z.string()).min(1).describe('List of task descriptions to work through'),
      }),
      execute: async (input: { goal: string; todos: string[] }) => {
        const list = {
          goal: input.goal,
          todos: input.todos.map(text => ({ id: crypto.randomUUID(), text, done: false })),
        };
        todoManager.save(scopeId, list);
        return `Todo list created.\n${todoManager.format(list)}`;
      },
    }),

    todo_add: tool({
      description: 'Append one or more tasks to the current todo list.',
      inputSchema: z.object({
        todos: z.array(z.string()).min(1).describe('Task descriptions to add'),
      }),
      execute: async (input: { todos: string[] }) => {
        const existing = todoManager.load(scopeId) ?? { goal: '', todos: [] };
        const newItems = input.todos.map(text => ({ id: crypto.randomUUID(), text, done: false }));
        const list = { ...existing, todos: [...existing.todos, ...newItems] };
        todoManager.save(scopeId, list);
        return `Tasks added.\n${todoManager.format(list)}`;
      },
    }),

    todo_update: tool({
      description:
        'Update a task in the todo list — mark it done/undone, change its text, or link it to a ' +
        'background specialist job. Use the first 8 characters of the task id shown in the list. ' +
        'After spawning a background specialist for a task, set waiting_on_job_id to the returned ' +
        'job ID — the framework then knows the item is delegated (not dropped) and will resume it ' +
        'when the specialist completes.',
      inputSchema: z.object({
        id: z.string().describe('Task id or id prefix (first 8 chars)'),
        done: z.boolean().describe('New completion status'),
        text: z.string().optional().describe('New task text (omit to keep existing)'),
        waiting_on_job_id: z
          .string()
          .optional()
          .describe('Background specialist job ID (from spawn_specialist) this task is delegated to'),
      }),
      execute: async (input: { id: string; done: boolean; text?: string; waiting_on_job_id?: string }) => {
        const list = todoManager.load(scopeId);
        if (!list) return 'Error: no todo list exists. Use todo_create to start one.';
        const item = list.todos.find(t => t.id.startsWith(input.id));
        if (!item) return `Error: task with id prefix "${input.id}" not found.`;
        const before = { done: item.done, text: item.text, waitingOnJobId: item.waitingOnJobId };
        item.done = input.done;
        if (input.text) item.text = input.text;
        if (input.done) {
          delete item.waitingOnJobId;
        } else if (input.waiting_on_job_id) {
          item.waitingOnJobId = input.waiting_on_job_id;
        }
        // A call that changes nothing used to save and return the same
        // "Task updated." string as a real one. Identical input producing
        // byte-identical output is a stable fixed point: a model that re-marks
        // a done task gets no signal that it accomplished nothing, and can
        // loop on it indefinitely (#55). Report the no-op explicitly and name
        // the next action instead. Not an error — re-marking is legitimate
        // after a crash/resume replay — and the list is left untouched, so
        // `updatedAt` keeps meaning "last actual change".
        const unchanged =
          before.done === item.done &&
          before.text === item.text &&
          before.waitingOnJobId === item.waitingOnJobId;
        if (unchanged) {
          const pending = todoManager.pendingItems(list);
          const next = pending.length
            ? `${pending.length} item(s) still pending — work the next one:\n${todoManager.format(list)}`
            : 'Every item on this list is now done. Call todo_clear if the task is complete, then reply to the user.';
          return `No change: "${item.text}" was already marked ${item.done ? 'done' : 'not done'}. Do not repeat this call.\n${next}`;
        }
        todoManager.save(scopeId, list);
        return `Task updated.\n${todoManager.format(list)}`;
      },
    }),

    todo_clear: tool({
      description: 'Clear the todo list entirely once a task is fully complete.',
      inputSchema: z.object({}),
      execute: async () => {
        todoManager.clear(scopeId);
        return 'Todo list cleared.';
      },
    }),
  };
}
