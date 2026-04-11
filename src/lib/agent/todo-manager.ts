import fs from 'fs';
import path from 'path';
import { getWorkspaceDir } from '../tools/built-in';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoList {
  goal: string;
  todos: TodoItem[];
}

// Re-export browser-safe utilities so server-side code can import from one place.
export { TODO_TOOL_NAMES, parseTodoOutput } from './todo-utils';
export type { ParsedTodo } from './todo-utils';

class TodoManager {
  private todosDir(): string {
    return path.join(getWorkspaceDir(), 'todos');
  }

  private filePath(chatId: string): string {
    // Sanitize chatId for use as a filename
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.todosDir(), `${safe}.json`);
  }

  load(chatId: string): TodoList | null {
    try {
      const raw = fs.readFileSync(this.filePath(chatId), 'utf-8');
      return JSON.parse(raw) as TodoList;
    } catch {
      return null;
    }
  }

  save(chatId: string, list: TodoList): void {
    const dir = this.todosDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath(chatId), JSON.stringify(list, null, 2), 'utf-8');
  }

  clear(chatId: string): void {
    try {
      fs.unlinkSync(this.filePath(chatId));
    } catch {
      // already gone
    }
  }

  /** Returns a markdown summary for system prompt injection, or '' if no list. */
  getSummary(chatId: string): string {
    const list = this.load(chatId);
    if (!list || list.todos.length === 0) return '';
    const lines = list.todos.map(t => `- [${t.done ? 'x' : ' '}] ${t.text} (id: ${t.id.slice(0, 8)})`);
    return `Goal: ${list.goal}\n${lines.join('\n')}`;
  }

  /** Format a TodoList as a human-readable string for tool responses. */
  format(list: TodoList): string {
    const lines = list.todos.map(t => `- [${t.done ? 'x' : ' '}] ${t.text} (id: ${t.id.slice(0, 8)})`);
    return `Goal: ${list.goal}\n${lines.join('\n')}`;
  }
}

export const todoManager = new TodoManager();
