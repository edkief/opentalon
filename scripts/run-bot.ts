import 'dotenv/config';
import { createBotFromEnv, startLongPolling, setupHandlers } from '../src/lib/telegram';

async function main() {
  console.log('=== OpenPincer Bot (Long Polling Mode) ===\n');

  const bot = createBotFromEnv();
  setupHandlers(bot);

  console.log('Bot initialized. Starting long polling...\n');
  console.log('Press Ctrl+C to stop.\n');

  await startLongPolling(bot);
}

main().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});
