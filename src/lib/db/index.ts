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
// Raw postgres.js client — used directly for LISTEN/NOTIFY (see
// db/jobs.ts and scheduler/index.ts waitForJobs), which drizzle doesn't
// wrap.
export const pgClient = queryClient;

export { schema };
export { addMessage, getConversationHistory, clearConversation, clearConversationForAgent, getLastTurnContextSize } from './conversation';
export type { LastTurnContextSize } from './conversation';
export { createJob, updateJobStatus, getJobsByChatId, getRunningJobsForChat } from './jobs';
export { createSecretRequest, getSecretRequest, markSecretRequest } from './secret-requests';
export { getActiveAgent, setActiveAgent, getAllAgentStates } from './agent-state';
export { recordPendingTurn, clearPendingTurn, getInflightTurns, incrementTurnAttempts } from './pending-turns';
export {
  getEmbedThread,
  upsertEmbedThread,
  updateEmbedThreadContext,
  getEmbedChatTitle,
  countEmbedThreadsByClient,
  claimEmbedInbound,
  pushEmbedOutbox,
  readEmbedOutbox,
  latestEmbedOutboxSeq,
  countEmbedOutbox,
  sweepEmbedOutbox,
  sweepEmbedInbound,
} from './embed';
export type { Job, NewJob, SecretRequest, AgentState, PendingTurn, NewPendingTurn } from './schema';
export type Database = typeof db;
