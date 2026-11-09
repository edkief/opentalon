/**
 * Resume for scheduled runs that hit the step limit (#86).
 *
 * A cron run has no `jobs` row, but it has everything a resume needs: its
 * orchestration record (`specialist_runs`: task, agent, chat, turn) and its
 * stored turn (`conversations`: the task message and the reply with its tool
 * calls). A resume is a new one-off run of the same task, as the same agent,
 * that replays that turn as history and gets the extra steps as its budget.
 */
import { InlineKeyboard } from 'grammy';
import type { NewConversation } from '../db/schema';
import type { SpecialistSummary } from '../agent/log-bus';
import type { Message } from '../agent/types';
import type { TaskData } from '../scheduler';

export const RESUME_RUN_PREFIX = 'resume_run_';
/** Telegram rejects callback data over 64 bytes. */
export const CALLBACK_DATA_LIMIT = 64;

export function resumeRunData(runId: string, steps: number): string {
  return `${RESUME_RUN_PREFIX}${runId}_${steps}`;
}

/** `resume_run_<runId>_<steps>` → its parts, or null if malformed. */
export function parseResumeRunData(data: string): { runId: string; steps: number } | null {
  if (!data.startsWith(RESUME_RUN_PREFIX)) return null;
  const rest = data.slice(RESUME_RUN_PREFIX.length);
  const cut = rest.lastIndexOf('_');
  if (cut <= 0) return null;
  const runId = rest.slice(0, cut);
  const steps = Number(rest.slice(cut + 1));
  if (!Number.isInteger(steps) || steps <= 0) return null;
  return { runId, steps };
}

/**
 * The keyboard for a scheduled run that stopped at its step limit. Resume is
 * offered only when the run has an orchestration record to resume from;
 * heartbeats don't, so they get Close only.
 */
export function stepLimitKeyboard(runId: string | undefined, stepLimit: number | undefined): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (runId) {
    const counts = [...new Set([stepLimit ?? 10, 20, 30])];
    for (const n of counts) keyboard.text(`Resume with ${n} more steps`, resumeRunData(runId, n)).row();
  }
  return keyboard.text('Close task', 'close_main');
}

export function stepLimitNotice(resumable: boolean): string {
  return resumable
    ? '⏸️ This task hit the step limit. Would you like to resume it?'
    : '⏸️ This task hit the step limit and stopped. The summary above says what remains.';
}

export function buildResumeTaskMessage(task: string): string {
  return (
    `[Scheduled Task Resumed]\n\n` +
    `Task: ${task}\n\n` +
    `Your previous run of this task stopped at the step limit; its steps and summary are above. ` +
    `Continue from where you left off. Don't redo work that is already done. ` +
    `When the task is complete, report back to the user.`
  );
}

/** The previous run's stored turn as history, with its tool calls replayed. */
export function buildResumeHistory(rows: Pick<NewConversation, 'role' | 'content' | 'parts'>[]): Message[] {
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    ...(r.role === 'assistant' && Array.isArray(r.parts) ? { parts: r.parts as Message['parts'] } : {}),
  }));
}

export interface ResumeDeps {
  getRun(runId: string): Promise<SpecialistSummary | null>;
  getTurn(turnId: string): Promise<NewConversation[]>;
  scheduleOnce(taskId: string, chatId: string, description: string, delayMs: number, extra: Partial<TaskData>): Promise<unknown>;
}

async function defaultDeps(): Promise<ResumeDeps> {
  const [{ getSpecialistRun }, { getTurnMessages }, { schedulerService }] = await Promise.all([
    import('../agent/orchestration-store'),
    import('../db/conversation'),
    import('../scheduler'),
  ]);
  return {
    getRun: getSpecialistRun,
    getTurn: getTurnMessages,
    scheduleOnce: (taskId, chatId, description, delayMs, extra) =>
      schedulerService.scheduleOnce(taskId, chatId, description, delayMs, extra),
  };
}

export type ResumeOutcome =
  | { ok: true; taskDescription: string; steps: number }
  | { ok: false; reason: string };

/** Queue a resume of a step-limited scheduled run in the chat it ran in. */
export async function resumeScheduledRun(
  chatId: string,
  runId: string,
  steps: number,
  deps?: ResumeDeps,
): Promise<ResumeOutcome> {
  const d = deps ?? await defaultDeps();
  const run = await d.getRun(runId);
  if (!run || run.parentSessionId !== chatId) return { ok: false, reason: 'this run is no longer on record.' };
  if (run.status !== 'max_steps') return { ok: false, reason: `this run is no longer stopped at its step limit (${run.status}).` };
  if (!run.turnId) return { ok: false, reason: 'this run has no stored turn to continue from.' };

  const rows = await d.getTurn(run.turnId);
  if (!rows.length) return { ok: false, reason: 'this run\'s conversation was cleared.' };
  const threadId = rows.find((r) => r.threadId)?.threadId ?? undefined;

  await d.scheduleOnce(`resume-${crypto.randomUUID()}`, chatId, run.taskDescription, 0, {
    // The run event leaves agentId out for the default agent.
    agentId: run.agentId ?? 'default',
    ...(threadId ? { threadId } : {}),
    resumeOfRunId: runId,
    maxSteps: steps,
  });
  return { ok: true, taskDescription: run.taskDescription, steps };
}
