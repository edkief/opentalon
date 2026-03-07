import { pgTable, serial, text, timestamp, integer, index } from 'drizzle-orm/pg-core';


export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    model: text('model'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => {
    return {
      chatIdIdx: index('chat_id_idx').on(table.chatId),
      createdAtIdx: index('created_at_idx').on(table.createdAt),
    };
  }
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'timed_out', 'max_steps_reached'],
    })
      .notNull()
      .default('pending'),
    taskDescription: text('task_description').notNull(),
    result: text('result'),
    errorMessage: text('error_message'),
    maxStepsUsed: integer('max_steps_used'),
    resumeOf: text('resume_of'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    chatIdIdx: index('jobs_chat_id_idx').on(t.chatId),
  })
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export const secretRequests = pgTable('secret_requests', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  reason: text('reason').notNull(),
  status: text('status', {
    enum: ['pending', 'fulfilled', 'declined', 'expired'],
  })
    .notNull()
    .default('pending'),
  chatId: text('chat_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

export type SecretRequest = typeof secretRequests.$inferSelect;

export const personaState = pgTable('persona_state', {
  chatId:      text('chat_id').primaryKey(),
  personaName: text('persona_name').notNull().default('default'),
  updatedAt:   timestamp('updated_at').defaultNow().notNull(),
});

export type PersonaState = typeof personaState.$inferSelect;
export type NewPersonaState = typeof personaState.$inferInsert;
