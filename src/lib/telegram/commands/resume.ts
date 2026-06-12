import type { Context } from 'grammy';
import { updateJobStatus, getJobById, createResumedJob, canResumeJob } from '../../db/jobs';
import { schedulerService } from '../../scheduler';

export async function handleResumeCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;

  const text = ctx.message?.text;
  if (!text) return;

  // Parse: /resume <job_id> [steps] [--guidance "your guidance here"]
  const parts = text.slice(8).trim().split(' ');
  if (parts.length < 1 || !parts[0]) {
    await ctx.reply(
      `<b>Usage:</b> /resume &lt;job_id&gt; [additional_steps] [--guidance "your guidance"]\n\n` +
      `Examples:\n` +
      `• /resume abc123 - resume with default steps\n` +
      `• /resume abc123 30 - resume with 30 more steps\n` +
      `• /resume abc123 30 --guidance "try a different approach"\n\n` +
      `You can find the job ID from the max steps or completion notification.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Parse --guidance flag
  let guidance: string | undefined;
  const guidanceIndex = parts.indexOf('--guidance');
  if (guidanceIndex !== -1) {
    guidance = parts.slice(guidanceIndex + 1).join(' ');
    parts.splice(guidanceIndex); // Remove --guidance and its value
  }

  const jobId = parts[0];
  const additionalSteps = parts[1] ? parseInt(parts[1], 10) : undefined;

  if (parts[1] && isNaN(additionalSteps!)) {
    await ctx.reply('Invalid number of steps. Please provide a valid number.');
    return;
  }

  const job = await getJobById(jobId);
  if (!job) {
    await ctx.reply(`Job not found: ${jobId}`);
    return;
  }

  // Allow resume from completed or max_steps_reached
  const validStatuses = ['completed', 'max_steps_reached'];
  if (!validStatuses.includes(job.status)) {
    await ctx.reply(`Job ${jobId} is not in a resumable status (current: ${job.status}). Only 'completed' or 'max_steps_reached' jobs can be resumed.`);
    return;
  }

  // Create a resumed job with guidance
  const newJobId = await createResumedJob(job, additionalSteps, guidance);

  // Schedule the resumed job
  await schedulerService.scheduleOnce(newJobId, chatId, job.taskDescription, 0, { specialistId: newJobId });

  // Update original job status
  await updateJobStatus(jobId, 'completed', undefined, 'Resumed');

  let message = `▶️ Resuming task...\n\n` +
    `Original job: ${jobId.slice(0, 8)}...\n` +
    `New job: ${newJobId.slice(0, 8)}...\n` +
    `Additional steps: ${additionalSteps ?? job.maxStepsUsed ?? 15}`;

  if (guidance) {
    message += `\nGuidance: ${guidance}`;
  }

  message += `\n\nThe task will continue in the background.`;

  await ctx.reply(message);
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.callbackQuery?.data) return;

  const data = ctx.callbackQuery.data;

  // Handle different resume patterns
  let jobId: string;
  let additionalSteps: number;

  if (data.startsWith('resume_main_')) {
    // Main agent resume - these don't have a stored job ID in the same way
    // For main agent, we'd need a different mechanism
    await ctx.answerCallbackQuery({ text: 'Main agent resume not yet implemented' });
    return;
  } else if (data.startsWith('resume_')) {
    // Parse: resume_<jobId> or resume_<jobId>_<steps>
    const rest = data.slice(7); // Remove 'resume_'
    const parts = rest.split('_');
    jobId = parts[0];
    additionalSteps = parts[1] ? parseInt(parts[1], 10) : 15;
  } else {
    return;
  }

  await ctx.answerCallbackQuery();

  const job = await getJobById(jobId);
  if (!job) {
    await ctx.editMessageText(`Job not found: ${jobId}`);
    return;
  }

  // Check if job can be resumed (max resume limit)
  const { canResume, reason } = canResumeJob(job);
  if (!canResume) {
    await ctx.editMessageText(`❌ Cannot resume: ${reason}`);
    return;
  }

  // Allow resume from completed or max_steps_reached
  const validStatuses = ['completed', 'max_steps_reached'];
  if (!validStatuses.includes(job.status)) {
    await ctx.editMessageText(`Job ${jobId.slice(0, 8)}... is no longer in a resumable status (${job.status}).`);
    return;
  }

  // Create a resumed job
  const newJobId = await createResumedJob(job, additionalSteps);

  // Schedule the resumed job
  await schedulerService.scheduleOnce(newJobId, chatId, job.taskDescription, 0, { specialistId: newJobId });

  // Update original job status
  await updateJobStatus(jobId, 'completed', undefined, 'Resumed');

  // Update the message to show it's been resumed
  await ctx.editMessageText(
    `▶️ Task resumed!\n\n` +
    `Original job: ${jobId.slice(0, 8)}...\n` +
    `New job: ${newJobId.slice(0, 8)}...\n` +
    `Additional steps: ${additionalSteps}\n\n` +
    `The task will continue in the background.`
  );
}
