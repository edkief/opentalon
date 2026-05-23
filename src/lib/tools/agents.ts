import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { agentRegistry } from '../soul';
import { getJobById, createResumedJob, updateJobStatus } from '../db/jobs';
import { schedulerService } from '../scheduler';
import type { BuiltInToolsOpts } from './types';

export function getAgentTools(opts?: BuiltInToolsOpts): ToolSet {
  if (!opts?.telegramChatId) return {};

  return {
    list_specialists: tool({
      description:
        'List all available specialist agents that can be used with spawn_specialist. ' +
        'Returns each agent\'s ID, description, and a short soul preview.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        let agents = agentRegistry.listAgents();
        if (Array.isArray(opts?.allowedSubAgents)) {
          agents = agents.filter((a) => (opts.allowedSubAgents as string[]).includes(a.id));
        }
        if (agents.length === 0) return 'No specialist agents available.';
        return JSON.stringify(
          agents.map((a) => ({
            id: a.id,
            description: a.description ?? null,
            soul_preview: a.soulPreview,
          })),
          null,
          2,
        );
      },
    } as any),

    resume_specialist: tool({
      description:
        'Resume a specialist task that hit the max steps limit or has completed. ' +
        'Use this when the user asks to resume a background task or wants to continue working on a completed task. ' +
        'You can find the job_id from the max steps or completion notification message. ' +
        'For completed jobs, provide guidance on what to do differently.',
      inputSchema: z.object({
        job_id: z.string().describe('The job ID of the task to resume'),
        additional_steps: z.number().optional().describe('Additional steps to allow (default: same as original limit)'),
        guidance: z.string().optional().describe('Additional guidance for what to do differently (especially for completed jobs)'),
      }) as any,
      execute: async (input: { job_id: string; additional_steps?: number; guidance?: string }) => {
        const job = await getJobById(input.job_id);
        if (!job) return `Job not found: ${input.job_id}`;

        const validStatuses = ['completed', 'max_steps_reached'];
        if (!validStatuses.includes(job.status)) {
          return `Job ${input.job_id} is not in a resumable status (current: ${job.status}). Only 'completed' or 'max_steps_reached' jobs can be resumed.`;
        }

        const chatId = job.chatId;
        const newJobId = await createResumedJob(job, input.additional_steps, input.guidance);
        await schedulerService.scheduleOnce(newJobId, chatId, job.taskDescription, 0, { specialistId: newJobId });
        await updateJobStatus(input.job_id, 'completed', undefined, 'Resumed via tool');

        return `Task resumed successfully.\nOriginal job: ${input.job_id.slice(0, 8)}...\nNew job: ${newJobId.slice(0, 8)}...\nAdditional steps: ${input.additional_steps ?? job.maxStepsUsed ?? 15}`;
      },
    } as any),
  };
}
