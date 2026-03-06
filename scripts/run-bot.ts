import 'dotenv/config';
import { createBotFromEnv, startLongPolling, setupHandlers, registerCommands } from '../src/lib/telegram';
import { personaRegistry } from '../src/lib/soul';

async function main() {
  console.log('=== OpenPincer Bot (Long Polling Mode) ===\n');

  personaRegistry.ensureDefaults();

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
