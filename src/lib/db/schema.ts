import { pgTable, serial, text, timestamp, integer, index, uniqueIndex, jsonb, boolean, primaryKey } from 'drizzle-orm/pg-core';


export const conversations = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    // AI SDK response.messages for this turn (assistant tool-call parts +
    // tool-result messages), replayed into the model prompt on later turns so
    // the model sees its past tool activity instead of prose claims about it.
    // Null for user/system rows and rows written before this column existed.
    parts: jsonb('parts').$type<unknown[]>(),
    // input_tokens is the TOTAL input incl. cache (matches AI SDK usage.inputTokens).
    // cache_read/cache_write are subsets of it; non-cached = input − cacheRead − cacheWrite.
    // reasoning_tokens is a subset of output_tokens (billed at the output rate).
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
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
    phase: text('phase', { enum: ['main', 'finalise', 'todo-check', 'specialist', 'summary'] })
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
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
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
    enum: ['pending', 'fulfilled', 'declined', 'guided', 'expired'],
  })
    .notNull()
    .default('pending'),
  // Transient carrier for the submitted value: on 'fulfilled' it holds the raw
  // secret, on 'guided' the guidance message. The polling request_secret tool
  // reads it once and immediately nulls it (clearSecretValue) so a raw secret's
  // at-rest lifetime here is bounded to one ~2s poll interval, not the row TTL.
  value: text('value'),
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
  // Full option descriptions, shown in the message body.
  options: text('options').array(),
  // Short button labels, positionally parallel to `options`. Null for rows
  // written before #40 — readers fall back to the description.
  labels: text('labels').array(),
  status: text('status', {
    enum: ['pending', 'responded', 'expired', 'failed'],
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

// ─── Email Channel ───────────────────────────────────────────────────────────
// One row per email message (inbound + outbound) seen by the agent. Outbound
// rows are recorded too so future replies to us resolve to the same chatId.
//
// NOTE: conversations.messageId is an integer (Telegram msg id) — email rows in
// `conversations` use messageId=0 (like web). The RFC Message-Id lives ONLY in
// this table.
export const emailMessages = pgTable(
  'email_messages',
  {
    // Normalized RFC Message-Id (angle brackets stripped, trimmed).
    messageId: text('message_id').primaryKey(),
    chatId: text('chat_id').notNull(),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    // IMAP UID (per mailbox/uidValidity). Null for outbound messages we send.
    imapUid: integer('imap_uid'),
    mailbox: text('mailbox'),
    fromAddress: text('from_address').notNull(),
    toAddresses: text('to_addresses').array().notNull(),
    ccAddresses: text('cc_addresses').array(),
    subject: text('subject'),
    // Re:/Fwd: stripped, lowercased, whitespace-collapsed — for subject-fallback threading.
    normalizedSubject: text('normalized_subject'),
    inReplyTo: text('in_reply_to'),
    // 'references' is a reserved-ish SQL identifier — column is references_ids.
    referencesIds: text('references_ids').array(),
    // false until the inbound pipeline finishes; lets a crashed mid-pipeline row be retried.
    processed: boolean('processed').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    chatIdIdx: index('email_messages_chat_id_idx').on(t.chatId),
    normSubjectCreatedIdx: index('email_messages_norm_subject_created_idx').on(
      t.normalizedSubject,
      t.createdAt,
    ),
  }),
);

export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;

// IMAP sync cursor per mailbox: the UID window we've already ingested for the
// current UIDVALIDITY. On UIDVALIDITY change we reset lastUid=0 and rely on
// Message-Id dedup during the full re-scan.
export const emailSyncState = pgTable('email_sync_state', {
  mailbox: text('mailbox').primaryKey(),
  // UIDVALIDITY is a uint32 — store as text to avoid pg integer overflow.
  uidValidity: text('uid_validity').notNull(),
  lastUid: integer('last_uid').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type EmailSyncState = typeof emailSyncState.$inferSelect;
export type NewEmailSyncState = typeof emailSyncState.$inferInsert;

// ─── Embed Channel ───────────────────────────────────────────────────────────
// Inbound HTTP conversations opened by a host application that embeds an agent
// chat surface in its own pages (TalonPress is the first client). chatIds are
// `embed:<clientId>:<16-hex>`, derived from (clientId, resourceId, userKey) —
// never supplied by the caller. See src/lib/embed/threads.ts.
//
// NOTE: conversations.messageId is an integer (Telegram msg id) — embed rows in
// `conversations` use messageId=0, like web and email.

// One row per conversation: who the host says is talking, about which resource,
// plus the latest page-context envelope the host has pushed.
export const embedThreads = pgTable(
  'embed_threads',
  {
    chatId: text('chat_id').primaryKey(),
    clientId: text('client_id').notNull(),
    // Host-side identifier of the thing being discussed (a TalonPress packageId).
    resourceId: text('resource_id').notNull(),
    // Opaque, stable-per-host-user key. The chatId hash is derived from it, so a
    // host that rotates this per session mints a new conversation every login.
    userKey: text('user_key').notNull(),
    userLabel: text('user_label'),
    title: text('title'),
    url: text('url'),
    // Latest EmbedResourceContext envelope (see src/lib/embed/context.ts).
    context: jsonb('context').$type<Record<string, unknown>>(),
    // Host-supplied version/hash of `context`. The rendered system-prompt block
    // is a pure function of this, so it doubles as the prompt-cache key.
    contextVersion: text('context_version'),
    // High-water mark for embed_outbox.seq on this chat. Kept here rather than
    // derived from max(seq) so that sweeping every outbox row for an idle chat
    // cannot restart numbering under a client that still holds an old cursor.
    lastSeq: integer('last_seq').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    clientResourceIdx: index('embed_threads_client_resource_idx').on(t.clientId, t.resourceId),
  }),
);

export type EmbedThread = typeof embedThreads.$inferSelect;
export type NewEmbedThread = typeof embedThreads.$inferInsert;

// Idempotency ledger for inbound messages. The host proxy may retry a POST that
// timed out while the turn was already running; claiming (chatId, clientMessageId)
// makes the retry a no-op that returns the original turnId.
export const embedInbound = pgTable(
  'embed_inbound',
  {
    chatId: text('chat_id').notNull(),
    clientMessageId: text('client_message_id').notNull(),
    turnId: text('turn_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.clientMessageId] }),
  }),
);

export type EmbedInbound = typeof embedInbound.$inferSelect;

// Durable outbound queue. An HTTP host has no push address, so everything the
// app sends to an embed chatId — agent replies, scheduled-task output, workflow
// notifications, guidance prompts — lands here and is drained by the client over
// SSE or polling.
//
// `seq` is a PER-CHAT counter allocated from embed_threads.lastSeq, not a global
// serial: a global sequence lets a late-committing transaction land behind a
// cursor the client has already advanced past, silently dropping a message.
// Allocation is a single atomic `UPDATE ... SET last_seq = last_seq + 1
// RETURNING last_seq`, so it stays monotonic even when an out-of-band push
// (scheduled task, workflow notification) interleaves with an agent reply.
export const embedOutbox = pgTable(
  'embed_outbox',
  {
    chatId: text('chat_id').notNull(),
    seq: integer('seq').notNull(),
    // 'message' = agent output; 'notice' = channel-level info (e.g. a denied
    // dangerous tool); 'error' = the turn failed.
    kind: text('kind', { enum: ['message', 'notice', 'error'] }).notNull().default('message'),
    role: text('role', { enum: ['assistant', 'system'] }).notNull().default('assistant'),
    content: text('content').notNull(),
    format: text('format', { enum: ['markdown', 'html'] }).notNull().default('markdown'),
    turnId: text('turn_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.seq] }),
    createdAtIdx: index('embed_outbox_created_at_idx').on(t.createdAt),
  }),
);

export type EmbedOutboxRow = typeof embedOutbox.$inferSelect;
export type NewEmbedOutboxRow = typeof embedOutbox.$inferInsert;

// ─── Pending Turns (crash-recovery for in-flight agent turns) ─────────────────
// One row per user-initiated agent turn, written before llmExecutor.chat() runs
// and deleted once the turn completes (reply delivered + persisted). A row that
// survives a restart marks a turn that was in flight when the process died: on
// startup those rows are re-enqueued and resumed. The already-executed steps are
// recovered from `conversation_steps` (keyed by the same turnId); this table only
// holds what's needed to re-drive the turn — the request, who runs it, and where
// to deliver the reply. See src/lib/telegram/resume-turn.ts.

export const pendingTurns = pgTable(
  'pending_turns',
  {
    turnId: text('turn_id').primaryKey(),
    chatId: text('chat_id').notNull(),
    agentId: text('agent_id').notNull(),
    messageId: integer('message_id').notNull(),
    // Memory scope the original turn ran under ('private' for DMs, 'shared' for groups).
    scope: text('scope', { enum: ['private', 'shared'] }).notNull(),
    // The exact user message content sent to the model (incl. any sender prefix),
    // so the resumed turn replays byte-identical to the original.
    userContent: text('user_content').notNull(),
    // Per-chat model pin in effect for the original turn, if any.
    modelOverride: text('model_override'),
    // Number of times startup recovery has attempted this turn — bounds retries
    // so a turn that reliably crashes the process can't loop forever.
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    chatIdIdx: index('pending_turns_chat_id_idx').on(t.chatId),
  }),
);

export type PendingTurn = typeof pendingTurns.$inferSelect;
export type NewPendingTurn = typeof pendingTurns.$inferInsert;

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
