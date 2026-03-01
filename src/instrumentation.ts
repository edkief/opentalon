export async function register() {
  // Only run in the Node.js runtime (not Edge), and only when long-polling is requested
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.TELEGRAM_USE_LONG_POLLING !== 'true') return;

  // Guard against duplicate starts across hot-reloads in dev
  const g = globalThis as typeof globalThis & { __botStarted?: boolean };
  if (g.__botStarted) return;
  g.__botStarted = true;

  try {
    const { createBotFromEnv, startLongPolling, registerCommands } = await import('./lib/telegram');
    const { setupHandlers } = await import('./lib/telegram/handlers');

    const bot = createBotFromEnv();
    setupHandlers(bot);
    await registerCommands(bot);

    console.log('[Instrumentation] Starting Telegram long-polling alongside Next.js...');
    // Fire-and-forget — startLongPolling awaits the runner task indefinitely
    startLongPolling(bot).catch((err: unknown) => {
      console.error('[Instrumentation] Long-polling crashed:', err);
    });
  } catch (err) {
    console.error('[Instrumentation] Failed to start Telegram bot:', err);
  }
}
