import { db } from '../db';
import { conversationSteps, specialistRuns } from '../db/schema';
import type { NewConversationStep, SpecialistRun } from '../db/schema';
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { SpecialistEvent, SpecialistSummary, StepEvent } from './log-bus';

// ─── Step persistence ──────────────────────────────────────────────────────────

function stepEventToRow(event: StepEvent): NewConversationStep {
  return {
    turnId: event.turnId ?? null,
    chatId: event.sessionId,
    threadId: event.threadId ?? null,
    agentId: event.agentId ?? null,
    specialistId: event.specialistId ?? null,
    phase: event.phase ?? 'main',
    stepIndex: event.stepIndex,
    finishReason: event.finishReason ?? null,
    text: event.text ?? null,
    reasoning: event.reasoning ?? null,
    toolCalls: event.toolCalls ?? null,
    toolResults: event.toolResults ?? null,
    ragContext: event.ragContext ?? null,
    systemPrompt: event.systemPrompt ?? null,
    inputTokens: event.inputTokens ?? null,
    outputTokens: event.outputTokens ?? null,
    cacheReadTokens: event.cacheReadTokens ?? null,
    cacheWriteTokens: event.cacheWriteTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
    model: event.model ?? null,
    durationMs: event.durationMs ?? null,
    errorMessage: event.errorMessage ?? null,
  };
}

function rowToStepEvent(row: typeof conversationSteps.$inferSelect): StepEvent {
  return {
    id: String(row.id),
    sessionId: row.chatId,
    threadId: row.threadId ?? undefined,
    timestamp: row.createdAt.toISOString(),
    stepIndex: row.stepIndex,
    finishReason: row.finishReason ?? '',
    text: row.text ?? undefined,
    reasoning: row.reasoning ?? undefined,
    toolCalls: row.toolCalls ?? undefined,
    toolResults: row.toolResults ?? undefined,
    ragContext: row.ragContext ?? undefined,
    systemPrompt: row.systemPrompt ?? undefined,
    agentId: row.agentId ?? undefined,
    specialistId: row.specialistId ?? undefined,
    turnId: row.turnId ?? undefined,
    phase: row.phase,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    cacheReadTokens: row.cacheReadTokens ?? undefined,
    cacheWriteTokens: row.cacheWriteTokens ?? undefined,
    reasoningTokens: row.reasoningTokens ?? undefined,
    model: row.model ?? undefined,
    durationMs: row.durationMs ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
  };
}

export async function persistStepEvent(event: StepEvent): Promise<void> {
  // One row per step. The progressive 'thinking'/'responding' stages are emitted
  // live-only (emitStepLive) and never reach here; only the final 'done' step is
  // persisted, so this stays a plain insert — identical to the classic path.
  await db.insert(conversationSteps).values(stepEventToRow(event));
}

export async function loadRunSteps(specialistId: string): Promise<StepEvent[]> {
  const rows = await db
    .select()
    .from(conversationSteps)
    .where(eq(conversationSteps.specialistId, specialistId))
    .orderBy(asc(conversationSteps.stepIndex), asc(conversationSteps.id));
  return rows.map(rowToStepEvent);
}

/**
 * Loads main-agent step history for a chat (steps not tied to a specialist).
 * Used by the Thought Stream to reload a chat's intermediate steps. Steps store
 * the concrete agent name (like the conversations table), so filtering by both
 * chatId and agentId scopes to a single agent's steps within a shared chat.
 */
export async function loadChatSteps(
  chatId?: string,
  agentId?: string,
  limit?: number,
  turnIds?: string[],
): Promise<StepEvent[]> {
  const conditions = [];
  if (chatId) conditions.push(eq(conversationSteps.chatId, chatId));
  if (agentId) conditions.push(eq(conversationSteps.agentId, agentId));
  // Scope to only the turns visible on the caller's page so unrelated steps
  // from other turns (outside the current history window) are excluded.
  if (turnIds && turnIds.length > 0) conditions.push(inArray(conversationSteps.turnId, turnIds));

  const base = db.select().from(conversationSteps);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;

  // Most-recent N, then return chronologically.
  const rows = await filtered
    .orderBy(desc(conversationSteps.createdAt), desc(conversationSteps.id))
    .limit(limit && limit > 0 ? limit : 500);

  return rows.reverse().map(rowToStepEvent);
}

/** Maps a light summary-select row to a `summary: true` StepEvent. */
function summaryRowToStepEvent(row: {
  id: number;
  chatId: string;
  agentId: string | null;
  specialistId: string | null;
  turnId: string | null;
  phase: typeof conversationSteps.$inferSelect['phase'];
  stepIndex: number;
  finishReason: string | null;
  toolCalls: { toolName: string; input: unknown }[] | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  model: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
  hasReasoning: boolean;
  hasRagContext: boolean;
  hasText: boolean;
}): StepEvent {
  return {
    summary: true,
    id: String(row.id),
    sessionId: row.chatId,
    timestamp: row.createdAt.toISOString(),
    stepIndex: row.stepIndex,
    finishReason: row.finishReason ?? '',
    // Names only — full inputs are stripped from the summary payload. The
    // collapsed tool-group view only needs names; inputs load on expand.
    toolCalls: row.toolCalls?.map((tc) => ({ toolName: tc.toolName, input: undefined })),
    agentId: row.agentId ?? undefined,
    specialistId: row.specialistId ?? undefined,
    turnId: row.turnId ?? undefined,
    phase: row.phase,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    cacheReadTokens: row.cacheReadTokens ?? undefined,
    cacheWriteTokens: row.cacheWriteTokens ?? undefined,
    reasoningTokens: row.reasoningTokens ?? undefined,
    model: row.model ?? undefined,
    durationMs: row.durationMs ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    hasReasoning: row.hasReasoning,
    hasRagContext: row.hasRagContext,
    hasText: row.hasText,
  };
}

/**
 * Light-payload variant of {@link loadChatSteps}: selects only the columns the
 * Thought Stream needs up-front (tool-call names, token counts, presence
 * flags), leaving the heavy bodies (reasoning / toolResults / systemPrompt /
 * text) in the DB until the user expands a step.
 */
export async function loadChatStepsSummary(
  chatId?: string,
  agentId?: string,
  limit?: number,
  turnIds?: string[],
): Promise<StepEvent[]> {
  const conditions = [];
  if (chatId) conditions.push(eq(conversationSteps.chatId, chatId));
  if (agentId) conditions.push(eq(conversationSteps.agentId, agentId));
  if (turnIds && turnIds.length > 0) conditions.push(inArray(conversationSteps.turnId, turnIds));

  const base = db
    .select({
      id: conversationSteps.id,
      chatId: conversationSteps.chatId,
      agentId: conversationSteps.agentId,
      specialistId: conversationSteps.specialistId,
      turnId: conversationSteps.turnId,
      phase: conversationSteps.phase,
      stepIndex: conversationSteps.stepIndex,
      finishReason: conversationSteps.finishReason,
      toolCalls: conversationSteps.toolCalls,
      inputTokens: conversationSteps.inputTokens,
      outputTokens: conversationSteps.outputTokens,
      cacheReadTokens: conversationSteps.cacheReadTokens,
      cacheWriteTokens: conversationSteps.cacheWriteTokens,
      reasoningTokens: conversationSteps.reasoningTokens,
      model: conversationSteps.model,
      durationMs: conversationSteps.durationMs,
      errorMessage: conversationSteps.errorMessage,
      createdAt: conversationSteps.createdAt,
      hasReasoning: sql<boolean>`${conversationSteps.reasoning} is not null`,
      hasRagContext: sql<boolean>`${conversationSteps.ragContext} is not null`,
      hasText: sql<boolean>`${conversationSteps.text} is not null`,
    })
    .from(conversationSteps);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;

  const rows = await filtered
    .orderBy(desc(conversationSteps.createdAt), desc(conversationSteps.id))
    .limit(limit && limit > 0 ? limit : 500);

  return rows.reverse().map(summaryRowToStepEvent);
}

/** Full detail for one persisted step, by numeric id. */
export async function loadStepDetail(id: string): Promise<StepEvent | null> {
  const numId = Number(id);
  if (!Number.isInteger(numId)) return null;
  const [row] = await db
    .select()
    .from(conversationSteps)
    .where(eq(conversationSteps.id, numId))
    .limit(1);
  return row ? rowToStepEvent(row) : null;
}

// ─── Specialist run summaries ────────────────────────────────────────────────────

function terminalStatus(
  kind: SpecialistEvent['kind'],
): SpecialistRun['status'] {
  switch (kind) {
    case 'complete':
      return 'complete';
    case 'error':
      return 'error';
    case 'max_steps':
      return 'max_steps';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

export async function persistSpecialistEvent(event: SpecialistEvent): Promise<void> {
  if (event.kind === 'spawn') {
    await db
      .insert(specialistRuns)
      .values({
        specialistId: event.specialistId,
        parentSessionId: event.parentSessionId,
        taskDescription: event.taskDescription,
        contextSnapshot: event.contextSnapshot ?? null,
        status: 'running',
        background: event.background ?? null,
        parentSpecialistId: event.parentSpecialistId ?? null,
        agentId: event.agentId ?? null,
        turnId: event.turnId ?? null,
        spawnedAt: new Date(event.timestamp),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: specialistRuns.specialistId,
        set: {
          parentSessionId: event.parentSessionId,
          taskDescription: event.taskDescription,
          contextSnapshot: event.contextSnapshot ?? null,
          background: event.background ?? null,
          parentSpecialistId: event.parentSpecialistId ?? null,
          agentId: event.agentId ?? null,
          turnId: event.turnId ?? null,
          spawnedAt: new Date(event.timestamp),
          updatedAt: new Date(),
        },
      });
    return;
  }

  // Terminal event — update the existing run row (insert as fallback if the
  // spawn write was lost/raced).
  const status = terminalStatus(event.kind);
  await db
    .insert(specialistRuns)
    .values({
      specialistId: event.specialistId,
      parentSessionId: event.parentSessionId,
      taskDescription: event.taskDescription,
      status,
      result: event.result ?? null,
      durationMs: event.durationMs ?? null,
      maxStepsUsed: event.maxStepsUsed ?? null,
      canResume: event.canResume ?? null,
      background: event.background ?? null,
      parentSpecialistId: event.parentSpecialistId ?? null,
      agentId: event.agentId ?? null,
      modelUsed: event.modelUsed ?? null,
      turnId: event.turnId ?? null,
      spawnedAt: new Date(event.timestamp),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: specialistRuns.specialistId,
      set: {
        status,
        result: event.result ?? null,
        durationMs: event.durationMs ?? null,
        maxStepsUsed: event.maxStepsUsed ?? null,
        canResume: event.canResume ?? null,
        // Only overwrite these when the terminal event carries a value.
        ...(event.background !== undefined ? { background: event.background } : {}),
        ...(event.parentSpecialistId !== undefined
          ? { parentSpecialistId: event.parentSpecialistId }
          : {}),
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(event.modelUsed !== undefined ? { modelUsed: event.modelUsed } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        updatedAt: new Date(),
      },
    });
}

function runToSummary(row: SpecialistRun): SpecialistSummary {
  return {
    specialistId: row.specialistId,
    parentSessionId: row.parentSessionId,
    taskDescription: row.taskDescription,
    contextSnapshot: row.contextSnapshot ?? undefined,
    status: row.status,
    result: row.result ?? undefined,
    durationMs: row.durationMs ?? undefined,
    maxStepsUsed: row.maxStepsUsed ?? undefined,
    canResume: row.canResume ?? undefined,
    background: row.background ?? undefined,
    spawnedAt: (row.spawnedAt ?? row.updatedAt).toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
    parentSpecialistId: row.parentSpecialistId ?? undefined,
    agentId: row.agentId ?? undefined,
    modelUsed: row.modelUsed ?? undefined,
    turnId: row.turnId ?? undefined,
  };
}

/** Appends the direct descendants of the given runs (depth ≤ 2), deduplicated. */
async function withDescendants(roots: SpecialistRun[]): Promise<SpecialistRun[]> {
  if (roots.length === 0) return [];
  const children = await db
    .select()
    .from(specialistRuns)
    .where(inArray(specialistRuns.parentSpecialistId, roots.map((r) => r.specialistId)))
    .orderBy(asc(specialistRuns.spawnedAt));
  const seen = new Set(roots.map((r) => r.specialistId));
  return [...roots, ...children.filter((c) => !seen.has(c.specialistId))];
}

/**
 * Loads all specialist runs spawned within one conversation turn, including
 * their descendants (depth ≤ 2: a turn's specialists may spawn sub-specialists
 * that don't carry the turnId themselves but link via parentSpecialistId).
 */
export async function loadTurnSpecialists(turnId: string): Promise<SpecialistSummary[]> {
  const roots = await db
    .select()
    .from(specialistRuns)
    .where(eq(specialistRuns.turnId, turnId))
    .orderBy(asc(specialistRuns.spawnedAt));
  return (await withDescendants(roots)).map(runToSummary);
}

/**
 * Fallback for runs written before specialist_runs.turn_id existed: matches by
 * explicit job ids (parsed from spawn_specialist tool outputs) plus a
 * chat + spawn-time window covering the turn.
 */
export async function loadTurnSpecialistsFallback(opts: {
  chatId: string;
  from: Date;
  to: Date;
  jobIds: string[];
}): Promise<SpecialistSummary[]> {
  const windowCond = and(
    eq(specialistRuns.parentSessionId, opts.chatId),
    gte(specialistRuns.spawnedAt, opts.from),
    lte(specialistRuns.spawnedAt, opts.to),
  );
  const where =
    opts.jobIds.length > 0
      ? or(inArray(specialistRuns.specialistId, opts.jobIds), windowCond)
      : windowCond;
  const roots = await db
    .select()
    .from(specialistRuns)
    .where(where)
    .orderBy(asc(specialistRuns.spawnedAt));
  // Keep only top-level matches as roots; descendants are re-attached below.
  const rootIds = new Set(roots.map((r) => r.specialistId));
  const topLevel = roots.filter((r) => !r.parentSpecialistId || !rootIds.has(r.parentSpecialistId));
  const nested = roots.filter((r) => r.parentSpecialistId && rootIds.has(r.parentSpecialistId));
  const all = await withDescendants(topLevel);
  const seen = new Set(all.map((r) => r.specialistId));
  return [...all, ...nested.filter((r) => !seen.has(r.specialistId))].map(runToSummary);
}

export async function queryIndex(opts: {
  search?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: SpecialistSummary[]; total: number }> {
  const where = opts.search
    ? or(
        ilike(specialistRuns.taskDescription, `%${opts.search}%`),
        ilike(specialistRuns.agentId, `%${opts.search}%`),
        ilike(specialistRuns.status, `%${opts.search}%`),
        ilike(specialistRuns.modelUsed, `%${opts.search}%`),
      )
    : undefined;

  const countRows = await (where
    ? db.select({ count: sql<number>`count(*)` }).from(specialistRuns).where(where)
    : db.select({ count: sql<number>`count(*)` }).from(specialistRuns));
  const total = Number(countRows[0]?.count ?? 0);

  const base = db.select().from(specialistRuns);
  const filtered = where ? base.where(where) : base;
  const rows = await filtered
    .orderBy(desc(specialistRuns.spawnedAt))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);

  return { items: rows.map(runToSummary), total };
}
