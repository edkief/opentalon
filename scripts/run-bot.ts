import 'dotenv/config';
import { createBotFromEnv, startLongPolling, setupHandlers, registerCommands } from '../src/lib/telegram';
import { agentRegistry } from '../src/lib/soul';
import { configManager } from '../src/lib/config';

async function main() {
  console.log('=== OpenTalon Bot (Long Polling Mode) ===\n');

  configManager.load();
  agentRegistry.ensureDefaults();

  const bot = createBotFromEnv();
  await setupHandlers(bot);
  await registerCommands(bot);

  console.log('Bot initialized. Starting long polling...\n');
  console.log('Press Ctrl+C to stop.\n');

  await startLongPolling(bot);
}

main().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});
