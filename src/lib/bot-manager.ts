// Node.js-only module — never imported by Edge runtime code.
// Manages the lifecycle of the embedded Telegram long-polling bot.

type BotGlobals = typeof globalThis & {
  __botStarted?: boolean;
  __botToken?: string;
  __botInstance?: import('./telegram/bot').AppBot;
  __botRunnerHandle?: import('./telegram/bot').RunnerHandle;
  __botConfigListener?: boolean;
};

function g(): BotGlobals {
  return globalThis as BotGlobals;
}

export async function startBot(): Promise<void> {
  const gl = g();
  try {
    const { createBotFromEnv, startLongPolling, registerCommands } = await import('./telegram');
    const { setupHandlers } = await import('./telegram/handlers');
    const { configManager } = await import('./config');

    const bot = createBotFromEnv();
    setupHandlers(bot);
    await registerCommands(bot);

    const token =
      configManager.getSecrets().telegram?.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '';

    gl.__botToken = token;
    gl.__botInstance = bot;

    console.log('[BotManager] Starting Telegram long-polling...');
    const handle = await startLongPolling(bot);
    gl.__botRunnerHandle = handle;

    handle.task()?.catch((err: unknown) => {
      console.error('[BotManager] Long-polling crashed:', err);
    });
  } catch (err) {
    console.error('[BotManager] Failed to start Telegram bot:', err);
    gl.__botStarted = false;
  }
}

export async function restartBot(): Promise<void> {
  const gl = g();

  if (gl.__botInstance && gl.__botRunnerHandle) {
    try {
      const { stopBot } = await import('./telegram/bot');
      await stopBot(gl.__botInstance, gl.__botRunnerHandle);
    } catch (err) {
      console.error('[BotManager] Error stopping bot:', err);
    }
    gl.__botInstance = undefined;
    gl.__botRunnerHandle = undefined;
    gl.__botToken = undefined;
  }

  gl.__botStarted = false;
  await startBot();
  gl.__botStarted = true;
  console.log('[BotManager] Bot restarted successfully.');
}

export function setupTokenHotReload(configManager: { getSecrets(): { telegram?: { botToken?: string } } }): void {
  const gl = g();
  if (gl.__botConfigListener) return;
  gl.__botConfigListener = true;

  import('./agent/log-bus').then(({ logBus }) => {
    logBus.on('config-changed', async () => {
      const newToken =
        configManager.getSecrets().telegram?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
      if (newToken && newToken !== gl.__botToken) {
        console.log('[BotManager] Bot token changed, hot-reloading bot...');
        await restartBot();
      }
    });
  });
}
