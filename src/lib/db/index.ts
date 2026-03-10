import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[DB] DATABASE_URL not set, database features will be disabled');
}

// Reuse the connection pool across HMR cycles in dev to avoid pool leaks.
declare global {
  // eslint-disable-next-line no-var
  var __pgClient: ReturnType<typeof postgres> | undefined;
}

if (!globalThis.__pgClient) {
  globalThis.__pgClient = postgres(connectionString || 'postgres://localhost:5432/postgres', {
    max: 10,
  });
}

const queryClient = globalThis.__pgClient;

export const db = drizzle(queryClient, { schema });

export { schema };
export { addMessage, getConversationHistory, clearConversation, clearConversationForPersona } from './conversation';
export { createJob, updateJobStatus, getJobsByChatId } from './jobs';
export { createSecretRequest, getSecretRequest, markSecretRequest } from './secret-requests';
export { getActivePersona, setActivePersona, getAllPersonaStates } from './persona-state';
export type { Job, NewJob, SecretRequest, PersonaState } from './schema';
export type Database = typeof db;
