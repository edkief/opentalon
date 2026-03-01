import { pgTable, serial, text, timestamp, integer, index } from 'drizzle-orm/pg-core';


export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
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
      enum: ['pending', 'running', 'completed', 'failed', 'timed_out'],
    })
      .notNull()
      .default('pending'),
    taskDescription: text('task_description').notNull(),
    result: text('result'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    chatIdIdx: index('jobs_chat_id_idx').on(t.chatId),
  })
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
