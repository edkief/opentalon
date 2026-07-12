import type { AppBot } from './bot';
import { setBot } from './send';
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

export async function setupHandlers(bot: AppBot): Promise<void> {
  // Scheduler init, the skills watcher, and channel notification listeners are
  // now started unconditionally from src/instrumentation.ts so they work with
  // Telegram off. This function only wires the Telegram-specific bot handlers.
  setBot(bot);
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
}
