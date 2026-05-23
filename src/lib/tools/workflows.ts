import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { db } from '../db';
import { workflows as workflowsTable } from '../db/schema';
import { ne, eq, inArray } from 'drizzle-orm';
import { workflowEngine } from '../workflow/engine';
import type { BuiltInToolsOpts } from './types';

export function getWorkflowTools(opts?: BuiltInToolsOpts): ToolSet {
  return {
    workflow_list: tool({
      description:
        'List all non-archived workflows (draft and active) with their id, name, and description. ' +
        'Use this to discover available workflows before triggering one with workflow_run.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        const allowedWf = opts?.allowedWorkflows;
        const query = db
          .select({ id: workflowsTable.id, name: workflowsTable.name, description: workflowsTable.description, status: workflowsTable.status })
          .from(workflowsTable);
        const rows = await (Array.isArray(allowedWf) && allowedWf.length > 0
          ? query.where(inArray(workflowsTable.id, allowedWf))
          : Array.isArray(allowedWf) && allowedWf.length === 0
            ? Promise.resolve([])
            : query.where(ne(workflowsTable.status, 'archived')));
        const filtered = Array.isArray(allowedWf)
          ? rows
          : rows.filter(r => r.status !== 'archived');
        return filtered.length === 0 ? 'No workflows found.' : JSON.stringify(filtered, null, 2);
      },
    } as any),

    workflow_run: tool({
      description:
        'Trigger a workflow by id. Optionally pass a free-text input message as trigger data — ' +
        'downstream nodes can access it as triggerData.message. ' +
        'HITL nodes in the workflow send an approval request to the triggering Telegram chat. ' +
        'Use workflow_list to find valid workflow ids.',
      inputSchema: z.object({
        workflow_id: z.string().describe('The workflow id to trigger'),
        input: z.string().optional().describe('Optional free-text message passed as triggerData.message to the workflow input node'),
      }) as any,
      execute: async (inp: { workflow_id: string; input?: string }) => {
        if (Array.isArray(opts?.allowedWorkflows) && !(opts.allowedWorkflows as string[]).includes(inp.workflow_id)) {
          return `Workflow "${inp.workflow_id}" not found.`;
        }
        const [wf] = await db
          .select({ status: workflowsTable.status })
          .from(workflowsTable)
          .where(eq(workflowsTable.id, inp.workflow_id))
          .limit(1);
        if (!wf) return `Workflow "${inp.workflow_id}" not found.`;
        if (wf.status === 'archived') return `Workflow "${inp.workflow_id}" is archived and cannot be run.`;
        const chatId = opts?.telegramChatId ?? 'agent';
        const triggerData: Record<string, unknown> = inp.input ? { message: inp.input } : {};
        try {
          const runId = await workflowEngine.createRun(inp.workflow_id, triggerData, chatId);
          return JSON.stringify({ runId, workflow_id: inp.workflow_id, status: 'started' });
        } catch (err) {
          return `Failed to start workflow: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as any),
  };
}
