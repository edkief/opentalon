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

  // Run workspace-level migrations (e.g. rename personas/ → agents/)
  const { runMigrations } = await import('./lib/migrations/runner');
  await runMigrations();

  // Ensure agent directory structure exists
  const { agentRegistry } = await import('./lib/soul');
  agentRegistry.ensureDefaults();

  // Load and watch config at server startup
  const { configManager } = await import('./lib/config');
  configManager.load();
  configManager.watch();

  // Apply git identity from config/secrets (runs on startup + on every reload)
  const { applyGitConfig } = await import('./lib/git-config');
  applyGitConfig(configManager.get(), configManager.getSecrets());

  // Periodically prune offloaded tool-result dumps in the OS temp dir. Sweep
  // once on boot (clears any leftovers from a crashed predecessor) then hourly.
  // Guarded so the interval isn't duplicated across dev hot-reloads.
  const gSweep = globalThis as typeof globalThis & { __toolDumpSweep?: boolean };
  if (!gSweep.__toolDumpSweep) {
    gSweep.__toolDumpSweep = true;
    const { sweepToolResultDumps } = await import('./lib/agent/middleware');
    const runSweep = () => {
      // Re-read config each sweep so changes take effect without a restart.
      const ttlHours = configManager.get().llm?.toolResultDumpTtlHours ?? 6;
      return sweepToolResultDumps(ttlHours * 60 * 60 * 1000)
        .then((n) => { if (n > 0) console.log(`[Instrumentation] Swept ${n} stale tool-result dump(s)`); })
        .catch((err) => console.error('[Instrumentation] Tool-dump sweep failed:', err));
    };
    runSweep();
    setInterval(runSweep, 60 * 60 * 1000).unref();
  }

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
