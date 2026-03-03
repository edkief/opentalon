export async function register() {
  // Only run in the Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Set up pino logger + console intercept before any other code runs
  const { setupConsoleIntercept } = await import('./lib/telemetry');
  setupConsoleIntercept();

  // Run database migrations in production
  if (process.env.NODE_ENV === 'production') {
    try {
      const { db } = await import('./lib/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(db, { migrationsFolder: './drizzle' });
      console.log('[Instrumentation] Database migrations completed');
    } catch (err) {
      console.error('[Instrumentation] Database migration failed:', err);
    }

    // Initialize Qdrant collection if available
    try {
      const { ensureCollection } = await import('./lib/memory/client');
      await ensureCollection();
      console.log('[Instrumentation] Qdrant collection ensured');
    } catch (err) {
      console.error('[Instrumentation] Qdrant initialization failed:', err);
    }
  }

  // Load and watch config at server startup
  const { configManager } = await import('./lib/config');
  configManager.load();
  configManager.watch();

  if (configManager.state === 'invalid') {
    console.error('[Instrumentation] Config invalid — running in fail-safe mode:', configManager.error);
    // Don't start the bot; dashboard still accessible for fixing config
    return;
  }

  // Start Telegram long-polling when requested
  const useLongPolling =
    configManager.get().telegram?.useLongPolling ??
    process.env.TELEGRAM_USE_LONG_POLLING === 'true';

  if (!useLongPolling) return;

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
    startLongPolling(bot).catch((err: unknown) => {
      console.error('[Instrumentation] Long-polling crashed:', err);
    });
  } catch (err) {
    console.error('[Instrumentation] Failed to start Telegram bot:', err);
  }
}
