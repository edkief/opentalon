import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[DB] DATABASE_URL not set, database features will be disabled');
}

const queryClient = postgres(connectionString || 'postgres://localhost:5432/postgres', {
  max: 10,
});

export const db = drizzle(queryClient, { schema });

export { schema };
export { addMessage, getConversationHistory, clearConversation } from './conversation';
export type Database = typeof db;
