import { pgTable, serial, text, timestamp, integer, index, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core';


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
    agentId: text('agent_id'),
    // Groups a user request, its intermediate steps, and the assistant reply.
    // Nullable for rows written before this column existed.
    turnId: text('turn_id'),
    // A /reset archives rows (active = false) instead of deleting them, so the
    // agent stops seeing them as context while the data is retained for
    // analytics/troubleshooting.
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => {
    return {
      chatIdIdx: index('chat_id_idx').on(table.chatId),
      createdAtIdx: index('created_at_idx').on(table.createdAt),
      chatAgentCreatedIdx: index('chat_agent_created_idx').on(
        table.chatId,
        table.agentId,
        table.createdAt,
      ),
      turnIdIdx: index('conversations_turn_id_idx').on(table.turnId),
    };
  }
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

// ─── Conversation Steps (intermediate agent steps) ──────────────────────────────
// One row per agent step. Covers main-agent turns, finalise turns, and specialist
// runs. Replaces the previous in-memory step buffer and on-disk orchestration store.

export const conversationSteps = pgTable(
  'conversation_steps',
  {
    id: serial('id').primaryKey(),
    // Groups main-agent steps within one user turn. Null for specialist-only steps.
    turnId: text('turn_id'),
    chatId: text('chat_id').notNull(),
    agentId: text('agent_id'),
    specialistId: text('specialist_id'),
    phase: text('phase', { enum: ['main', 'finalise', 'specialist', 'summary'] })
      .notNull()
      .default('main'),
    stepIndex: integer('step_index').notNull(),
    finishReason: text('finish_reason'),
    text: text('text'),
    reasoning: text('reasoning'),
    toolCalls: jsonb('tool_calls').$type<{ toolName: string; input: unknown }[]>(),
    toolResults: jsonb('tool_results').$type<
      { toolName: string; output: string; isError?: boolean }[]
    >(),
    ragContext: text('rag_context'),
    systemPrompt: text('system_prompt'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    model: text('model'),
    durationMs: integer('duration_ms'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    turnIdIdx: index('conversation_steps_turn_id_idx').on(t.turnId),
    specialistIdIdx: index('conversation_steps_specialist_id_idx').on(t.specialistId),
    chatAgentCreatedIdx: index('conversation_steps_chat_agent_created_idx').on(
      t.chatId,
      t.agentId,
      t.createdAt,
    ),
  }),
);

export type ConversationStep = typeof conversationSteps.$inferSelect;
export type NewConversationStep = typeof conversationSteps.$inferInsert;

// ─── Specialist Runs (orchestration summaries) ──────────────────────────────────
// One row per specialist/sub-agent run. Replaces the file-based summary index.

export const specialistRuns = pgTable(
  'specialist_runs',
  {
    specialistId: text('specialist_id').primaryKey(),
    parentSessionId: text('parent_session_id').notNull(),
    taskDescription: text('task_description').notNull(),
    contextSnapshot: text('context_snapshot'),
    status: text('status', {
      enum: ['running', 'complete', 'error', 'max_steps', 'cancelled'],
    })
      .notNull()
      .default('running'),
    result: text('result'),
    durationMs: integer('duration_ms'),
    maxStepsUsed: integer('max_steps_used'),
    canResume: boolean('can_resume'),
    background: boolean('background'),
    parentSpecialistId: text('parent_specialist_id'),
    agentId: text('agent_id'),
    modelUsed: text('model_used'),
    // Links the run to the conversation turn whose agent spawned it.
    // Nullable for rows written before this column existed.
    turnId: text('turn_id'),
    spawnedAt: timestamp('spawned_at'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    spawnedAtIdx: index('specialist_runs_spawned_at_idx').on(t.spawnedAt),
    parentSpecialistIdIdx: index('specialist_runs_parent_specialist_id_idx').on(
      t.parentSpecialistId,
    ),
    turnIdIdx: index('specialist_runs_turn_id_idx').on(t.turnId),
  }),
);

export type SpecialistRun = typeof specialistRuns.$inferSelect;
export type NewSpecialistRun = typeof specialistRuns.$inferInsert;

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'timed_out', 'max_steps_reached', 'awaiting_input'],
    })
      .notNull()
      .default('pending'),
    taskDescription: text('task_description').notNull(),
    result: text('result'),
    errorMessage: text('error_message'),
    maxStepsUsed: integer('max_steps_used'),
    resumeOf: text('resume_of'),
    userGuidance: text('user_guidance'),
    resumeCount: integer('resume_count').notNull().default(0),
    batchId: text('batch_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    chatIdIdx: index('jobs_chat_id_idx').on(t.chatId),
    batchIdIdx: index('jobs_batch_id_idx').on(t.batchId),
  })
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export const specialistBatches = pgTable('specialist_batches', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  agentId: text('agent_id'),
  expectedCount: integer('expected_count').notNull(),
  mode: text('mode', { enum: ['direct', 'synthesis'] }).notNull(),
  status: text('status', { enum: ['pending', 'dispatched'] }).notNull().default('pending'),
  originalRequest: text('original_request'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type SpecialistBatch = typeof specialistBatches.$inferSelect;
export type NewSpecialistBatch = typeof specialistBatches.$inferInsert;

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

export const agentState = pgTable('agent_state', {
  chatId:    text('chat_id').primaryKey(),
  agentName: text('agent_name').notNull().default('default'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type AgentState = typeof agentState.$inferSelect;
export type NewAgentState = typeof agentState.$inferInsert;

export const userInputs = pgTable('user_inputs', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull(),
  prompt: text('prompt').notNull(),
  options: text('options').array(),
  status: text('status', {
    enum: ['pending', 'responded', 'expired'],
  }).notNull().default('pending'),
  response: text('response'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type UserInput = typeof userInputs.$inferSelect;
export type NewUserInput = typeof userInputs.$inferInsert;

// ─── File Shares ───────────────────────────────────────────────────────────────

export const fileShares = pgTable(
  'file_shares',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    path: text('path').notNull(),
    mimeHint: text('mime_hint'),
    agentId: text('agent_id'),
    chatId: text('chat_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at'),
  },
  (t) => ({
    slugIdx: uniqueIndex('file_shares_slug_idx').on(t.slug),
  }),
);

export type FileShare = typeof fileShares.$inferSelect;
export type NewFileShare = typeof fileShares.$inferInsert;

// ─── Workflow Orchestrator ─────────────────────────────────────────────────────

export const workflows = pgTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    // execution-semantic data only — never read by engine
    definition: jsonb('definition').notNull().$type<{
      nodes: WorkflowNodeDef[];
      edges: WorkflowEdgeDef[];
    }>(),
    // React Flow positions — never read by engine
    layout: jsonb('layout').$type<Record<string, { x: number; y: number }>>(),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index('workflows_status_idx').on(t.status),
  })
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'paused', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    triggerData: jsonb('trigger_data').$type<Record<string, unknown>>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    workflowIdIdx: index('workflow_runs_workflow_id_idx').on(t.workflowId),
    statusIdx: index('workflow_runs_status_idx').on(t.status),
  })
);

export const workflowRunNodes = pgTable(
  'workflow_run_nodes',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text('node_id').notNull(),
    nodeType: text('node_type', {
      enum: ['agent', 'parallel', 'condition', 'hitl', 'input', 'output', 'code'],
    }).notNull(),
    status: text('status', {
      enum: ['waiting', 'running', 'completed', 'failed', 'skipped', 'awaiting_hitl'],
    })
      .notNull()
      .default('waiting'),
    inputData: jsonb('input_data').$type<Record<string, unknown>>(),
    outputData: jsonb('output_data').$type<Record<string, unknown>>(),
    // atomic counter for fan-in synchronization on parallel nodes
    completedChildCount: integer('completed_child_count').notNull().default(0),
    jobId: text('job_id'),
    hitlId: text('hitl_id'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    runIdIdx: index('workflow_run_nodes_run_id_idx').on(t.runId),
    runStatusIdx: index('workflow_run_nodes_run_status_idx').on(t.runId, t.status),
    jobIdIdx: index('workflow_run_nodes_job_id_idx').on(t.jobId),
  })
);

export const workflowHitlRequests = pgTable(
  'workflow_hitl_requests',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => workflowRuns.id),
    nodeId: text('node_id').notNull(),
    prompt: text('prompt').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] })
      .notNull()
      .default('pending'),
    chatId: text('chat_id'),
    expiresAt: timestamp('expires_at').notNull(),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    runIdIdx: index('workflow_hitl_run_id_idx').on(t.runId),
    statusIdx: index('workflow_hitl_status_idx').on(t.status),
  })
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type WorkflowRunNode = typeof workflowRunNodes.$inferSelect;
export type NewWorkflowRunNode = typeof workflowRunNodes.$inferInsert;
export type WorkflowHitlRequest = typeof workflowHitlRequests.$inferSelect;

// ─── Workflow Type Definitions ────────────────────────────────────────────────

export type WorkflowNodeType = 'agent' | 'parallel' | 'condition' | 'hitl' | 'input' | 'output' | 'code';
export type WorkflowNodeStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'skipped' | 'awaiting_hitl';
export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';

export interface AgentNodeConfig {
  taskTemplate: string;
  contextTemplate?: string;
  agentId?: string;
  modelOverride?: string;
  maxSteps?: number;
  timeoutMs?: number;
}

export interface ParallelNodeConfig {
  childNodeIds: string[];
  joinStrategy: 'all' | 'first';
}

export interface ConditionNodeConfig {
  expression: string;
  trueEdgeLabel: string;
  falseEdgeLabel: string;
}

export interface HITLNodeConfig {
  prompt: string;
  ttlMs: number;
  autoApprove?: boolean;
}

export interface InputNodeConfig {
  schema?: Record<string, string>;
  inputPrompt?: string;
}

export interface OutputNodeConfig {
  outputField?: string;
}

export interface CodeNodeConfig {
  code: string;
  timeoutMs?: number;
}

export type WorkflowNodeConfig =
  | AgentNodeConfig
  | ParallelNodeConfig
  | ConditionNodeConfig
  | HITLNodeConfig
  | InputNodeConfig
  | OutputNodeConfig
  | CodeNodeConfig;

export interface WorkflowNodeDef {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: WorkflowNodeConfig;
}

export interface WorkflowEdgeDef {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  dataMapping?: Record<string, string>;
}
