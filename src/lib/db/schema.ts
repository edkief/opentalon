import { pgTable, serial, text, timestamp, integer, index, jsonb } from 'drizzle-orm/pg-core';


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
