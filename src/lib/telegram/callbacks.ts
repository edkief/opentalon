import type { Context } from 'grammy';
import { updateJobStatus, getJobById } from '../db/jobs';
import { getUserInput, resolveUserInput } from '../db/user-inputs';
import { guidanceOptionsFromRow } from '../guidance-options';
import { resolveApproval } from '../agent/hitl';
import { workflowEngine } from '../workflow/engine';
import { escapeHtml } from './format';

export async function handleApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const match = data.match(/^(approve|deny):(.+)$/);
  if (!match) return;

  const approved = match[1] === 'approve';
  const approvalId = match[2];

  const resolved = resolveApproval(approvalId, approved);

  if (resolved) {
    await ctx.answerCallbackQuery(approved ? '✅ Approved' : '❌ Denied');
  } else {
    await ctx.answerCallbackQuery('⏱️ Request already expired');
  }

  // Remove the inline keyboard from the message
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
}

export async function handleWorkflowHITLCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const match = data.match(/^workflow_hitl_(approve|deny):(.+)$/);
  if (!match) return;

  const approved = match[1] === 'approve';
  const hitlId = match[2];

  try {
    await workflowEngine.handleHITLResolved(hitlId, approved);
    await ctx.answerCallbackQuery(approved ? '✅ Approved' : '❌ Denied');
    await ctx.editMessageText(
      approved ? '✅ <b>Workflow HITL approved</b>' : '❌ <b>Workflow HITL denied</b>',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.answerCallbackQuery('Failed to resolve approval');
    console.error('[WorkflowHITL] handleHITLResolved error:', err);
  }
}

export async function handleGuidanceCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.callbackQuery?.data) return;

  const data = ctx.callbackQuery.data;

  // Parse: guidance_{inputId}_{optionIndex} (index keeps callback_data under
  // Telegram's 64-byte limit; legacy in-flight messages carry the option text).
  if (!data.startsWith('guidance_')) return;

  const rest = data.slice(9); // Remove 'guidance_'
  const separatorIndex = rest.indexOf('_');
  if (separatorIndex === -1) return;

  const inputId = rest.slice(0, separatorIndex);
  const token = rest.slice(separatorIndex + 1);

  // The button only carries the index, so the label (short, for the
  // confirmation) and the description (full text handed back to the agent) are
  // both read from the stored row. Legacy in-flight messages carry the option
  // text itself, which is used for both.
  let option = token;
  let label = token;
  if (/^\d+$/.test(token)) {
    const record = await getUserInput(inputId);
    const resolved = guidanceOptionsFromRow(record?.options, record?.labels)?.[Number(token)];
    if (resolved !== undefined) {
      option = resolved.description;
      label = resolved.label;
    }
  }

  await ctx.answerCallbackQuery();

  // Resolve the user input
  await resolveUserInput(inputId, option);

  const detail = label === option ? '' : `\n\n${escapeHtml(option)}`;
  await ctx.editMessageText(
    `✅ Guidance received: <b>${escapeHtml(label)}</b>${detail}\n\nThe agent will continue with your guidance.`,
    { parse_mode: 'HTML' }
  );
}

/** Handle closing a task that hit max steps */
export async function handleCloseCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.callbackQuery?.data) return;

  const data = ctx.callbackQuery.data;

  // Parse: close_<jobId> or close_main
  if (!data.startsWith('close_')) return;

  const rest = data.slice(6); // Remove 'close_'

  await ctx.answerCallbackQuery();

  if (rest === 'main') {
    // For main agent, just dismiss the message
    await ctx.editMessageText('✅ Task closed.');
  } else {
    // For specialist jobs, update the job status to completed
    const jobId = rest;
    const job = await getJobById(jobId);
    if (job) {
      await updateJobStatus(jobId, 'completed', undefined, 'Closed by user');
      await ctx.editMessageText(`✅ Task closed.`);
    } else {
      await ctx.editMessageText('Task not found.');
    }
  }
}
