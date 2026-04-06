import { NextResponse } from 'next/server';
import { mcpRegistry } from '@/lib/tools/registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Static built-in tool names grouped by category.
// These are always present when a chatId is available.
const BUILTIN_TOOLS: { name: string; category: string }[] = [
  // Terminal
  { name: 'run_command',           category: 'terminal' },
  { name: 'read_file',              category: 'terminal' },
  { name: 'str_replace_based_edit', category: 'terminal' },
  { name: 'fuzzy_patch',           category: 'terminal' },
  // Skills
  { name: 'skill_list',            category: 'skills' },
  { name: 'skill_get',             category: 'skills' },
  { name: 'skill_save',            category: 'skills' },
  { name: 'skill_add_script',      category: 'skills' },
  { name: 'skill_delete',          category: 'skills' },
  // Web
  { name: 'web_search',            category: 'web' },
  { name: 'web_fetch',             category: 'web' },
  // Memory / RAG
  { name: 'rag_search',            category: 'memory' },
  { name: 'memory_read',           category: 'memory' },
  { name: 'memory_append',         category: 'memory' },
  { name: 'memory_delete',         category: 'memory' },
  // Todos
  { name: 'todo_create',           category: 'todos' },
  { name: 'todo_add',              category: 'todos' },
  { name: 'todo_update',           category: 'todos' },
  { name: 'todo_clear',            category: 'todos' },
  // Scheduling
  { name: 'schedule_task',         category: 'scheduling' },
  { name: 'list_scheduled_tasks',  category: 'scheduling' },
  { name: 'schedule_once',         category: 'scheduling' },
  { name: 'delete_scheduled_task', category: 'scheduling' },
  // Workflows
  { name: 'workflow_list',         category: 'workflows' },
  { name: 'workflow_run',          category: 'workflows' },
  // Communication
  { name: 'send_file',             category: 'communication' },
  { name: 'request_secret',        category: 'communication' },
  // Browser
  { name: 'browser_navigate',      category: 'browser' },
  { name: 'browser_snapshot',      category: 'browser' },
  { name: 'browser_get',           category: 'browser' },
  { name: 'browser_act',           category: 'browser' },
  { name: 'browser_screenshot',    category: 'browser' },
  { name: 'browser_close',         category: 'browser' },
];

export async function GET() {
  // Dynamic MCP tools registered at runtime
  const mcpTools = mcpRegistry.listToolNames().map((name) => ({
    name,
    category: 'mcp',
  }));

  return NextResponse.json({
    tools: [...BUILTIN_TOOLS, ...mcpTools],
  });
}
