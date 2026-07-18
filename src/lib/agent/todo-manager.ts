import fs from 'fs';
import path from 'path';
import { getWorkspaceDir } from '../tools/built-in';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  /** Background specialist job this item is delegated to; set via todo_update
   * after spawn_specialist(background:true). Cleared when the item is done. */
  waitingOnJobId?: string;
}

export interface TodoList {
  goal: string;
  todos: TodoItem[];
  /** ISO timestamp of the last save — stamped by TodoManager.save(). */
  updatedAt?: string;
}

// Re-export browser-safe utilities so server-side code can import from one place.
export { TODO_TOOL_NAMES, parseTodoOutput } from './todo-utils';
export type { ParsedTodo } from './todo-utils';

/**
 * A pending todo list untouched for longer than this is treated as abandoned
 * by the fresh-start policy (cleared at the next user-initiated turn). Chosen
 * to survive the ask-clarify-continue flow (user answers within minutes) while
 * killing lists left over from long-finished tasks.
 */
export const TODO_STALE_TTL_MS = 30 * 60_000;

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

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
    list.updatedAt = new Date().toISOString();
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
    // Age line grounds the model's judgment of whether the list is still the
    // current task. Minute granularity — the volatile prompt block already
    // changes per-minute (timestamp), so this adds no extra cache busting.
    const ageMs = list.updatedAt ? Date.now() - new Date(list.updatedAt).getTime() : undefined;
    const ageLine =
      ageMs !== undefined && ageMs >= 0
        ? `(last updated ${formatAge(ageMs)} ago)\n`
        : '';
    return ageLine + this.format(list);
  }

  /**
   * True when the list hasn't been touched within {@link TODO_STALE_TTL_MS}.
   * Legacy lists without an updatedAt stamp are treated as stale.
   */
  isStale(list: TodoList): boolean {
    if (!list.updatedAt) return true;
    return Date.now() - new Date(list.updatedAt).getTime() > TODO_STALE_TTL_MS;
  }

  /** Format a TodoList as a human-readable string for tool responses. */
  format(list: TodoList): string {
    const lines = list.todos.map(t => {
      const waiting = !t.done && t.waitingOnJobId ? ` [delegated to background job ${t.waitingOnJobId.slice(0, 8)}]` : '';
      return `- [${t.done ? 'x' : ' '}] ${t.text} (id: ${t.id.slice(0, 8)})${waiting}`;
    });
    return `Goal: ${list.goal}\n${lines.join('\n')}`;
  }

  /** Pending (not-done) items of a list; convenience shared by executor checks. */
  pendingItems(list: TodoList | null): TodoItem[] {
    return list?.todos.filter(t => !t.done) ?? [];
  }
}

export const todoManager = new TodoManager();
