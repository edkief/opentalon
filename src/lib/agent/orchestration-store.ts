import { db } from '../db';
import { conversationSteps, specialistRuns } from '../db/schema';
import type { NewConversationStep, SpecialistRun } from '../db/schema';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { SpecialistEvent, SpecialistSummary, StepEvent } from './log-bus';

// ─── Step persistence ──────────────────────────────────────────────────────────

function stepEventToRow(event: StepEvent): NewConversationStep {
  return {
    turnId: event.turnId ?? null,
    chatId: event.sessionId,
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
    inputTokens: event.inputTokens ?? null,
    outputTokens: event.outputTokens ?? null,
    model: event.model ?? null,
    durationMs: event.durationMs ?? null,
    errorMessage: event.errorMessage ?? null,
  };
}

function rowToStepEvent(row: typeof conversationSteps.$inferSelect): StepEvent {
  return {
    id: String(row.id),
    sessionId: row.chatId,
    timestamp: row.createdAt.toISOString(),
    stepIndex: row.stepIndex,
    finishReason: row.finishReason ?? '',
    text: row.text ?? undefined,
    reasoning: row.reasoning ?? undefined,
    toolCalls: row.toolCalls ?? undefined,
    toolResults: row.toolResults ?? undefined,
    ragContext: row.ragContext ?? undefined,
    agentId: row.agentId ?? undefined,
    specialistId: row.specialistId ?? undefined,
    turnId: row.turnId ?? undefined,
    phase: row.phase,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    model: row.model ?? undefined,
    durationMs: row.durationMs ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
  };
}

export async function persistStepEvent(event: StepEvent): Promise<void> {
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
  };
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
