import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { todoManager } from '../agent/todo-manager';
import type { BuiltInToolsOpts } from './types';

export function getTodoTools(opts?: BuiltInToolsOpts): ToolSet {
  // Todos are keyed by an explicit scope id so each execution context (main agent
  // = chatId, each specialist = its own specialistId) gets an isolated list.
  const scopeId = opts?.todoScopeId ?? opts?.telegramChatId;
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
        'Update a task in the todo list — mark it done/undone or change its text. ' +
        'Use the first 8 characters of the task id shown in the list.',
      inputSchema: z.object({
        id: z.string().describe('Task id or id prefix (first 8 chars)'),
        done: z.boolean().describe('New completion status'),
        text: z.string().optional().describe('New task text (omit to keep existing)'),
      }),
      execute: async (input: { id: string; done: boolean; text?: string }) => {
        const list = todoManager.load(scopeId);
        if (!list) return 'No todo list exists. Use todo_create to start one.';
        const item = list.todos.find(t => t.id.startsWith(input.id));
        if (!item) return `Task with id prefix "${input.id}" not found.`;
        item.done = input.done;
        if (input.text) item.text = input.text;
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
