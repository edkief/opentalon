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

  // Ensure persona directory structure exists
  const { personaRegistry } = await import('./lib/soul');
  personaRegistry.ensureDefaults();

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

  const { startBot, setupTokenHotReload } = await import('./lib/bot-manager');
  await startBot();
  setupTokenHotReload(configManager);
}
