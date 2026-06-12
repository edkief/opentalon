import { InlineKeyboard, InputFile } from 'grammy';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { llmExecutor } from '../agent';
import { ingestMemory } from '../memory';
import { addMessage, getActiveAgent } from '../db';
import { updateJobStatus, getJobById } from '../db/jobs';
import { getRegisteredTools, getBuiltInTools, getWorkspaceDir, getSkillsSummary } from '../tools';
import { createSpecialistTools } from '../agent/specialist';
import { notifyBatchMemberComplete } from '../agent/specialist-batch';
import { resolveApproval } from '../agent/hitl';
import { isChatText } from '../agent/types';
import type { Message } from '../agent/types';
import type { TaskData } from '../scheduler';
import { emitSpecialist } from '../agent/log-bus';
import { agentRegistry } from '../soul';
import { IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS } from './format';
import { enqueueForChat } from './state';
import { sendToChat, getBot } from './send';

/**
 * Called by the scheduler when a scheduled task or background specialist job fires.
 * Enqueued via the per-chatId queue so it never interleaves with active message processing.
 * When data.specialistId is set the job originated from spawn_specialist(background:true).
 */
export async function runScheduledTask(data: TaskData): Promise<void> {
  const { chatId, description, specialistId, agentId: taskAgentId, spawningAgentId, parentSpecialistId, synthesis: isSynthesisTurn } = data;
  const isHeartbeat = data.taskId?.startsWith('heartbeat-') && description === '__heartbeat__';
  const activeAgent = taskAgentId ?? await getActiveAgent(chatId);

  // For specialist jobs, get maxStepsUsed from the job record
  let maxStepsOverride: number | undefined;
  if (specialistId) {
    const job = await getJobById(specialistId);
    if (job?.maxStepsUsed) {
      maxStepsOverride = job.maxStepsUsed;
    }
  }

  enqueueForChat(chatId, async () => {
    const startMs = Date.now();

    // A plain scheduled cron task runs as the main agent (no specialistId). To
    // make it visible on the Orchestration page and persist across restarts, we
    // record it as a root orchestration run using a generated id. Heartbeats are
    // excluded — they fire frequently and would bloat the run index.
    const recordCronRun = !specialistId && !isHeartbeat;
    const runId = recordCronRun ? crypto.randomUUID() : undefined;

    // Update job status to running (if it's a background specialist job)
    if (specialistId) {
      await updateJobStatus(specialistId, 'running').catch(console.error);
    }

    if (runId) {
      emitSpecialist({
        id: crypto.randomUUID(),
        kind: 'spawn',
        specialistId: runId,
        parentSessionId: chatId,
        taskDescription: description,
        timestamp: new Date().toISOString(),
        agentId: activeAgent === 'default' ? undefined : activeAgent,
      });
    }

    // Wrap the entire execution so any unexpected error (e.g. soul manager failure,
    // tool setup error, LLM error) is caught, reported, and never left stuck as 'running'.
    const handleError = async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[runScheduledTask] Unhandled error:', message);
      if (specialistId) {
        await updateJobStatus(specialistId, 'failed', undefined, message).catch(console.error);
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'error',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: message,
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
        });
        // Notify the batch dispatcher (if this job belongs to a batch, failure is still terminal).
        notifyBatchMemberComplete(specialistId).catch(console.error);
        await sendToChat(chatId, `❌ Background task failed: ${message}`).catch(console.error);
      } else if (runId) {
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'error',
          specialistId: runId,
          parentSessionId: chatId,
          taskDescription: description,
          result: message,
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          agentId: activeAgent === 'default' ? undefined : activeAgent,
        });
      }
    };

    // Auto-approve all tools — no HITL during automated runs
    const autoApprove = (approvalId: string): Promise<void> => {
      setImmediate(() => resolveApproval(approvalId, true));
      return Promise.resolve();
    };

    let scheduledAgentCfg: any;
    let builtInTools: ToolSet, mcpTools: ToolSet, skillsSummary: string;
    try {
      scheduledAgentCfg = agentRegistry.getSoulManager(activeAgent).getConfig();
      [builtInTools, mcpTools, skillsSummary] = await Promise.all([
        Promise.resolve(getBuiltInTools({
          sendApprovalRequest: autoApprove,
          telegramChatId: chatId,
          memoryScope: 'private',
          sendTelegramMessage: sendToChat,
          allowedSkills: scheduledAgentCfg.allowedSkills ?? null,
          allowedWorkflows: scheduledAgentCfg.allowedWorkflows ?? null,
          allowedSubAgents: scheduledAgentCfg.allowedSubAgents ?? null,
        })),
        getRegisteredTools({ sendApprovalRequest: autoApprove }),
        getSkillsSummary(),
      ]);
    } catch (err) {
      await handleError(err);
      return;
    }

    // Build a bot-API-based send_file since there is no Grammy ctx in automated runs
    const bot = getBot();
    const send_file = bot
      ? tool({
          description:
            'Send a local file to the current Telegram chat. ' +
            'Images (.jpg/.jpeg/.png/.gif/.webp) are displayed inline as photos. ' +
            'Audio (.mp3/.ogg/.wav/.m4a/.flac/.aac/.opus) is playable inline. ' +
            'Video (.mp4/.mov/.mkv/.webm) is playable inline. ' +
            'All other formats are sent as downloadable documents.',
          inputSchema: z.object({
            path: z.string().describe('Absolute path to the local file to send'),
            caption: z.string().optional().describe('Optional caption shown below the file'),
          }) as any,
          execute: async (input: { path: string; caption?: string }) => {
            const ext = path.extname(input.path).toLowerCase();
            const file = new InputFile(input.path);
            const opts = input.caption ? { caption: input.caption } : {};
            try {
              if (IMAGE_EXTS.has(ext)) {
                await bot.api.sendPhoto(chatId, file, opts);
              } else if (AUDIO_EXTS.has(ext)) {
                await bot.api.sendAudio(chatId, file, opts);
              } else if (VIDEO_EXTS.has(ext)) {
                await bot.api.sendVideo(chatId, file, opts);
              } else {
                await bot.api.sendDocument(chatId, file, opts);
              }
              return `File sent: ${input.path}`;
            } catch (err) {
              return `Failed to send file: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        } as any)
      : undefined;

    const baseTools: ToolSet = { ...builtInTools, ...mcpTools, ...(send_file ? { send_file } : {}) };

    // If this is a background specialist that was spawned by an agent with sub-agent permissions,
    // provide the spawn_specialist and await_specialists tools at depth=1.
    // createSpecialistTools returns await_specialists only when currentSpecialistId is set,
    // enabling the fork-and-wait pattern without chat-queue deadlocks.
    const agentConfig = scheduledAgentCfg;
    // Pass activeAgent (mozart) as the spawningAgentId so that permission checks
    // for sub-agent spawning use mozart's own config, not the config of whoever
    // originally spawned mozart.
    const tools: ToolSet = spawningAgentId || (agentConfig.canSpawnSubAgents && agentConfig.allowedSubAgents?.length)
      ? { ...baseTools, ...createSpecialistTools(1, baseTools, chatId, activeAgent, specialistId) }
      : baseTools;

    const history: Message[] = [];

    let taskMessage: string;
    if (isHeartbeat) {
      const sm = agentRegistry.getSoulManager(activeAgent);
      const checklist = sm.getHeartbeatContent().trim();
      const body = checklist
        ? `Review this checklist:\n\n${checklist}`
        : 'Perform a general status check.';
      taskMessage =
        `[Heartbeat Check-In]\n\n${body}\n\n` +
        `If everything is nominal and nothing needs attention, respond with exactly: HEARTBEAT_OK\n` +
        `Otherwise, report your findings concisely.`;
    } else {
      const label = specialistId ? 'Background Specialist Task' : 'Scheduled Task Triggered';
      taskMessage =
        `[${label}]\n\n` +
        `Task: ${description}\n\n` +
        `Please carry out this task now and report back to the user.`;
    }

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: taskMessage },
    ];

    const skillsContext = skillsSummary
      ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
      : '\n\nNo skills saved yet.';

    let response;
    try {
      response = await llmExecutor.chat({
        messages,
        context: `Telegram chat_id: ${chatId}. Agent workspace: ${getWorkspaceDir()}. This is an automated run — no user is waiting. Complete the task and send a concise summary.${skillsContext}`,
        memoryScope: 'private',
        chatId,
        tools,
        agentId: activeAgent,
        maxSteps: maxStepsOverride,
        specialistId,
        orchestrationRunId: runId,
      });
    } catch (err) {
      // AbortError means cancel was requested — the cancellation path already emitted the
      // 'cancelled' specialist event and updated the DB, so don't overwrite with an error.
      if (err instanceof Error && err.name === 'AbortError') return;
      await handleError(err);
      return;
    }

    if (!isChatText(response) || !response.text.trim()) {
      // Job produced no text — mark it completed so it doesn't stay stuck as 'running'
      if (specialistId) {
        await updateJobStatus(specialistId, 'completed', '(no output)').catch(console.error);
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'complete',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: '(no output)',
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: isChatText(response) ? response.provider : undefined,
        });
        notifyBatchMemberComplete(specialistId).catch(console.error);
      } else if (runId) {
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'complete',
          specialistId: runId,
          parentSessionId: chatId,
          taskDescription: description,
          result: '(no output)',
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: isChatText(response) ? response.provider : undefined,
        });
      }
      return;
    }

    const replyText = response.text.trim();

    // Suppress heartbeat message when agent reports nothing to do
    if (isHeartbeat && replyText === 'HEARTBEAT_OK') return;

    const hitMaxSteps = response.hitMaxSteps ?? false;
    const maxStepsUsed = response.maxStepsUsed;

    if (specialistId) {
      if (hitMaxSteps) {
        // Emit max_steps event
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'max_steps',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: replyText.slice(0, 2_000),
          durationMs: Date.now() - startMs,
          maxStepsUsed,
          canResume: true,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: response.provider,
        });

        // Update job status in DB
        await updateJobStatus(specialistId, 'max_steps_reached', replyText.slice(0, 5_000), undefined, maxStepsUsed);

        // Re-read batchId (stamped after dispatch, before completion).
        const jobForBatch = await getJobById(specialistId);
        if (jobForBatch?.batchId) {
          // Batched: treat as terminal so the dispatcher can synthesize all results.
          notifyBatchMemberComplete(specialistId).catch(console.error);
        } else {
          // Standalone: offer per-specialist resume keyboard.
          const keyboard = new InlineKeyboard()
            .text(`Resume with ${maxStepsUsed ?? 15} more steps`, `resume_${specialistId}`)
            .row()
            .text('Resume with 30 more steps', `resume_${specialistId}_30`)
            .row()
            .text('Resume with 50 more steps', `resume_${specialistId}_50`)
            .row()
            .text('Close task', `close_${specialistId}`);
          await sendToChat(chatId, `${replyText}\n\n⏸️ This task hit the step limit. Would you like to resume it?`, { reply_markup: keyboard });
        }
      } else {
        emitSpecialist({
          id: crypto.randomUUID(),
          kind: 'complete',
          specialistId,
          parentSessionId: chatId,
          taskDescription: description,
          result: replyText.slice(0, 2_000),
          durationMs: Date.now() - startMs,
          timestamp: new Date().toISOString(),
          parentSpecialistId,
          agentId: activeAgent === 'default' ? undefined : activeAgent,
          modelUsed: response.provider,
        });
        await updateJobStatus(specialistId, 'completed', replyText.slice(0, 5_000));
        // Delivery is handled by the batch dispatcher (direct or synthesis).
        notifyBatchMemberComplete(specialistId).catch(console.error);
      }
    } else {
      if (hitMaxSteps) {
        if (runId) {
          // canResume is false: cron runs have no DB job record, so the
          // dashboard's Resume button (which calls /api/specialist/resume) must
          // not be offered. Main-agent resume is handled via the keyboard below.
          emitSpecialist({
            id: crypto.randomUUID(),
            kind: 'max_steps',
            specialistId: runId,
            parentSessionId: chatId,
            taskDescription: description,
            result: replyText.slice(0, 2_000),
            durationMs: Date.now() - startMs,
            maxStepsUsed,
            canResume: false,
            timestamp: new Date().toISOString(),
            agentId: activeAgent === 'default' ? undefined : activeAgent,
            modelUsed: response.provider,
          });
        }

        const keyboard = new InlineKeyboard()
          .text(`Resume with ${maxStepsUsed ?? 10} more steps`, `resume_main_${maxStepsUsed ?? 10}`)
          .row()
          .text('Resume with 20 more steps', `resume_main_20`)
          .row()
          .text('Resume with 30 more steps', `resume_main_30`)
          .row()
          .text('Close task', `close_main`);

        await sendToChat(chatId, `${replyText}\n\n⏸️ This task hit the step limit. Would you like to resume it?`, { reply_markup: keyboard });
      } else {
        if (runId) {
          emitSpecialist({
            id: crypto.randomUUID(),
            kind: 'complete',
            specialistId: runId,
            parentSessionId: chatId,
            taskDescription: description,
            result: replyText.slice(0, 2_000),
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
            agentId: activeAgent === 'default' ? undefined : activeAgent,
            modelUsed: response.provider,
          });
        }

        await sendToChat(chatId, isHeartbeat
          ? `💓 **Heartbeat**\n\n${replyText}`
          : isSynthesisTurn
            ? replyText
            : `⏰ **Scheduled task complete**\n\n${replyText}`);
      }
    }

    // Persist result to conversation history and memory.
    // Batched agent-spawned specialists are persisted by the batch dispatcher instead.
    if (!specialistId) {
      const jobTurnId = isChatText(response) ? response.turnId : undefined;
      addMessage(chatId, 0, 'user', taskMessage, activeAgent, undefined, jobTurnId).catch(console.error);
      addMessage(chatId, 0, 'assistant', replyText, activeAgent, {
        inputTokens: response.result?.usage?.inputTokens,
        outputTokens: response.result?.usage?.outputTokens,
        model: response.provider,
      }, jobTurnId).catch(console.error);
      ingestMemory({ chatId, scope: 'private', author: 'user', text: taskMessage, agent: activeAgent }).catch(console.error);
      ingestMemory({ chatId, scope: 'private', author: 'exchange', text: `User: ${taskMessage}\nAssistant: ${replyText}`, agent: activeAgent }).catch(console.error);
    }
  });
}
