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
  handleNewCommand,
  handleCompactCommand,
  handleRefreshSkillsCommand,
} from './commands/info';
import { handleCancelCommand, handleCancelCallback } from './commands/cancel';
import { handleResumeCommand, handleResumeCallback } from './commands/resume';
import { handleScopeCommand, handleScopeCallback } from './commands/scope';
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
  bot.command('new', handleNewCommand);
  bot.command('compact', handleCompactCommand);
  bot.command('cancel', handleCancelCommand);
  bot.command('refresh_skills', handleRefreshSkillsCommand);
  bot.command('resume', handleResumeCommand);
  bot.command('listagents', handleListAgentsCommand);
  bot.command('agent', handleAgentCommand);
  bot.command('listmodels', handleListModelsCommand);
  bot.command('setmodel', handleSetModelCommand);
  bot.command('resetmodel', handleResetModelCommand);
  bot.command('scope', handleScopeCommand);
  bot.on('message:text', handleMessage);
  bot.callbackQuery(/^(approve|deny):/, handleApprovalCallback);
  bot.callbackQuery(/^workflow_hitl_(approve|deny):/, handleWorkflowHITLCallback);
  bot.callbackQuery(/^setmodel:/, handleModelCallback);
  bot.callbackQuery(/^scope:/, handleScopeCallback);
  bot.callbackQuery(/^agent:/, handleAgentCallback);
  bot.callbackQuery(/^resume_/, handleResumeCallback);
  bot.callbackQuery(/^close_/, handleCloseCallback);
  bot.callbackQuery('cancel_force', handleCancelCallback);
  bot.callbackQuery(/^guidance_/, handleGuidanceCallback);
}
