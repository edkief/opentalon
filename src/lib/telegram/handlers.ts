import { InlineKeyboard } from 'grammy';
import path from 'node:path';
import { getWorkspaceDir, invalidateSkillsCache } from '../tools';
import { schedulerService } from '../scheduler';
import { logBus } from '../agent/log-bus';
import type { WorkflowEvent } from '../agent/log-bus';
import type { AppBot } from './bot';
import { db } from '../db';
import { workflowHitlRequests, workflows } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { escapeHtml } from './format';
import { sendToChat, setBot } from './send';
import { runScheduledTask } from './scheduled-task';
import {
  handleListModelsCommand,
  handleSetModelCommand,
  handleModelCallback,
  handleResetModelCommand,
} from './commands/model';
import {
  handleListAgentsCommand,
  handleAgentCommand,
  handleAgentCallback,
} from './commands/agent';
import {
  handleStartCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleResetCommand,
  handleRefreshSkillsCommand,
} from './commands/info';
import { handleResumeCommand, handleResumeCallback } from './commands/resume';
import {
  handleApprovalCallback,
  handleWorkflowHITLCallback,
  handleGuidanceCallback,
  handleCloseCallback,
} from './callbacks';
import { handleMessage } from './message';

// Re-exported so existing importers ('../telegram/handlers') keep working.
export { sendToChat } from './send';
export { runScheduledTask } from './scheduled-task';

function setupSkillsWatcher() {
  const skillsDir = path.join(getWorkspaceDir(), 'skills');
  import('node:fs').then((fs) => {
    if (!fs.existsSync(skillsDir)) return;
    try {
      const watcher = fs.watch(skillsDir, { recursive: true }, (eventType, filename) => {
        if (filename && (filename.endsWith('/SKILL.md') || filename.endsWith('.sh'))) {
          console.log(`[Skills] File changed: ${filename}, invalidating cache`);
          invalidateSkillsCache();
        }
      });
      console.log('[Skills] Watching for changes in:', skillsDir);
    } catch (e) {
      console.warn('[Skills] Failed to watch skills directory:', e);
    }
  });
}

export async function setupHandlers(bot: AppBot): Promise<void> {
  setBot(bot);
  await schedulerService.initialize(runScheduledTask);
  setupSkillsWatcher();
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);
  bot.command('status', handleStatusCommand);
  bot.command('reset', handleResetCommand);
  bot.command('refresh_skills', handleRefreshSkillsCommand);
  bot.command('resume', handleResumeCommand);
  bot.command('listagents', handleListAgentsCommand);
  bot.command('agent', handleAgentCommand);
  bot.command('listmodels', handleListModelsCommand);
  bot.command('setmodel', handleSetModelCommand);
  bot.command('resetmodel', handleResetModelCommand);
  bot.on('message:text', handleMessage);
  bot.callbackQuery(/^(approve|deny):/, handleApprovalCallback);
  bot.callbackQuery(/^workflow_hitl_(approve|deny):/, handleWorkflowHITLCallback);
  bot.callbackQuery(/^setmodel:/, handleModelCallback);
  bot.callbackQuery(/^agent:/, handleAgentCallback);
  bot.callbackQuery(/^resume_/, handleResumeCallback);
  bot.callbackQuery(/^close_/, handleCloseCallback);
  bot.callbackQuery(/^guidance_/, handleGuidanceCallback);

  // Deliver workflow outcome notifications to the triggering Telegram chat
  logBus.on('workflow', async (event: WorkflowEvent) => {
    try {
      if (event.kind === 'hitl_requested' && event.runId && event.nodeId) {
        const [req] = await db
          .select()
          .from(workflowHitlRequests)
          .where(
            and(
              eq(workflowHitlRequests.runId, event.runId),
              eq(workflowHitlRequests.nodeId, event.nodeId),
              eq(workflowHitlRequests.status, 'pending'),
            )
          )
          .limit(1);
        if (!req?.chatId) return;
        const keyboard = new InlineKeyboard()
          .text('✅ Approve', `workflow_hitl_approve:${req.id}`)
          .text('❌ Deny', `workflow_hitl_deny:${req.id}`);
        await sendToChat(req.chatId, `📋 <b>Workflow approval needed</b>\n\n${escapeHtml(req.prompt)}`, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        return;
      }

      if (!event.chatId || event.chatId === 'system') return;

      if (event.kind === 'run_completed') {
        const [wf] = await db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, event.workflowId)).limit(1);
        const name = wf?.name ?? event.workflowId;
        const resultLine = event.result ? `\n\n${escapeHtml(event.result.slice(0, 800))}` : '';
        await sendToChat(event.chatId, `✅ <b>Workflow completed</b>: ${escapeHtml(name)}${resultLine}`, { parse_mode: 'HTML' });
        return;
      }

      if (event.kind === 'run_failed') {
        const [wf] = await db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, event.workflowId)).limit(1);
        const name = wf?.name ?? event.workflowId;
        const errorLine = event.errorMessage ? `\n\nError: ${escapeHtml(event.errorMessage.slice(0, 500))}` : '';
        await sendToChat(event.chatId, `❌ <b>Workflow failed</b>: ${escapeHtml(name)}${errorLine}`, { parse_mode: 'HTML' });
        return;
      }
    } catch (err) {
      console.error('[WorkflowNotify] Failed to send notification:', err);
    }
  });

  // Listen for user input request events and send prompts to users
  logBus.on('user-input', async (event) => {
    const { inputId, chatId, prompt, options } = event;

    if (options && options.length > 0) {
      // Send inline keyboard with options
      const keyboard = new InlineKeyboard();
      for (const opt of options) {
        keyboard.text(opt, `guidance_${inputId}_${opt}`);
      }

      await sendToChat(chatId, `🤔 <b>Guidance needed</b>\n\n${prompt}`, { reply_markup: keyboard });
    } else {
      // Send prompt asking for free-text response
      await sendToChat(chatId, `🤔 <b>Guidance needed</b>\n\n${prompt}\n\n<i>Please reply with your guidance.</i>`);
    }
  });
}
