/**
 * Browser-safe todo utilities — no Node.js imports.
 * Import this in client components instead of todo-manager.ts.
 */

export const TODO_TOOL_NAMES = new Set(['todo_create', 'todo_add', 'todo_update', 'todo_clear']);

export interface ParsedTodo {
  goal: string;
  items: { done: boolean; text: string; id: string }[];
}

/** Parse a formatted todo tool output string back into structured data. Returns null for cleared/unrecognised. */
export function parseTodoOutput(output: string): ParsedTodo | null {
  if (output.trim() === 'Todo list cleared.') return null;
  const lines = output.split('\n');
  const goalLine = lines.find(l => l.startsWith('Goal: '));
  if (!goalLine) return null;
  const goal = goalLine.slice(6).trim();
  const items = lines
    .map(l => l.match(/^- \[([x ])\] (.+?) \(id: ([a-f0-9]+)\)$/))
    .filter(Boolean)
    .map(m => ({ done: m![1] === 'x', text: m![2], id: m![3] }));
  return { goal, items };
}
