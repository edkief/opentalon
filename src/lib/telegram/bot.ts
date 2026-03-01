import { Bot, type Context } from 'grammy';
import { run } from '@grammyjs/runner';
import type { TelegramConfig } from './types';

export type AppBot = Bot<Context>;

function createBot(config: TelegramConfig): AppBot {
  const bot = new Bot(config.botToken);

  // Handle errors
  bot.errorBoundary((error) => {
    console.error('[Telegram Bot] Error:', error);
  });

  return bot;
}

export function createBotFromEnv(): AppBot {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  return createBot({ botToken });
}

export async function registerCommands(bot: AppBot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show help and available commands' },
    { command: 'clear', description: 'Clear conversation history' },
  ]);
  console.log('[Telegram] Bot commands registered.');
}

export async function startLongPolling(bot: AppBot): Promise<void> {
  console.log('[Telegram] Starting long polling (concurrent runner)...');
  const handle = run(bot);
  await handle.task();
}

export async function startWebhook(bot: AppBot, path: string = '/api/webhook'): Promise<void> {
  console.log(`[Telegram] Webhook ready at ${path}`);
  // Webhook is handled by the Next.js API route
}

export function isLongPollingEnabled(): boolean {
  return process.env.TELEGRAM_USE_LONG_POLLING === 'true';
}

export { createBot };
