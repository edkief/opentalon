import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { schedulerService } from '../scheduler';

/**
 * Returns scheduling tools scoped to the given chatId.
 * Only included when a telegramChatId is available.
 */
export function getSchedulingTools(chatId: string): ToolSet {
  return {
    schedule_task: tool({
      description:
        'Create a new scheduled task that will run automatically on a cron schedule. ' +
        'The agent will be invoked with your description at each scheduled time. ' +
        'Use standard 5-field cron syntax: "minute hour day-of-month month day-of-week". ' +
        'Examples: "0 9 * * 1-5" (9am weekdays), "0 8 * * *" (8am daily), "*/30 * * * *" (every 30 min).',
      inputSchema: z.object({
        description: z
          .string()
          .describe(
            'Natural language description of what the agent should do when this task runs. ' +
              'Be specific and self-contained, e.g. "Fetch the latest Bitcoin price and send a summary".',
          ),
        cron_expression: z
          .string()
          .describe(
            'Standard 5-field cron expression. Example: "0 9 * * 1-5" for 9am on weekdays.',
          ),
      }) as any,
      execute: async (input: { description: string; cron_expression: string }) => {
        const taskId = crypto.randomUUID();
        await schedulerService.scheduleTask(taskId, chatId, input.description, input.cron_expression);
        const schedules = await schedulerService.getSchedules(chatId);
        const created = schedules.find((s) => s.taskId === taskId);
        return JSON.stringify({
          taskId,
          description: input.description,
          cron: input.cron_expression,
          nextRunAt: created?.nextRunAt ?? null,
          message: `Scheduled task created (ID: ${taskId}). Next run: ${created?.nextRunAt ?? 'unknown'}.`,
        });
      },
    } as any),

    list_scheduled_tasks: tool({
      description: 'List all scheduled tasks for this chat, including their next run time.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        const tasks = await schedulerService.getSchedules(chatId);
        if (tasks.length === 0) return 'No scheduled tasks found for this chat.';
        return JSON.stringify(
          tasks.map((t) => ({
            taskId: t.taskId,
            description: t.description,
            cron: t.cron,
            nextRunAt: t.nextRunAt,
          })),
          null,
          2,
        );
      },
    } as any),

    schedule_once: tool({
      description:
        'Schedule a one-off task to run once after a specified delay. ' +
        'The task runs once and is then automatically deleted. ' +
        'Use this for "remind me in X minutes" type requests.',
      inputSchema: z.object({
        description: z
          .string()
          .describe(
            'What the agent should do when the task runs. ' +
              'Be specific and self-contained, e.g. "Remind me to take my medication".',
          ),
        delay_minutes: z
          .number()
          .int()
          .positive()
          .describe('Delay in minutes before the task runs (e.g. 5 for 5 minutes).'),
      }) as any,
      execute: async (input: { description: string; delay_minutes: number }) => {
        const taskId = crypto.randomUUID();
        const delayMs = input.delay_minutes * 60 * 1000;
        await schedulerService.scheduleOnce(taskId, chatId, input.description, delayMs);
        const runAt = new Date(Date.now() + delayMs).toISOString();
        return JSON.stringify({
          taskId,
          description: input.description,
          delayMinutes: input.delay_minutes,
          runAt,
          message: `One-off task scheduled (ID: ${taskId}). Will run at: ${runAt}`,
        });
      },
    } as any),

    delete_scheduled_task: tool({
      description: 'Delete a scheduled task permanently by its ID.',
      inputSchema: z.object({
        task_id: z.string().describe('The task ID to delete (from list_scheduled_tasks)'),
      }) as any,
      execute: async (input: { task_id: string }) => {
        await schedulerService.unschedule(input.task_id);
        return `Scheduled task ${input.task_id} deleted.`;
      },
    } as any),
  };
}
