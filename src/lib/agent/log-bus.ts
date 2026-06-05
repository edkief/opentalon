import { EventEmitter } from 'node:events';

export type StepPhase = 'main' | 'finalise' | 'specialist' | 'summary';

export interface StepEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  stepIndex: number;
  finishReason: string;
  text?: string;
  reasoning?: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; output: string; isError?: boolean }[];
  ragContext?: string;
  agentId?: string;
  specialistId?: string;
  // Groups main-agent steps within one user turn (links to conversations.turnId).
  turnId?: string;
  phase?: StepPhase;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  durationMs?: number;
  // Set when the model/step itself failed (e.g. all fallbacks exhausted).
  errorMessage?: string;
}

const TOOL_OUTPUT_LIMIT = 10_000;

/**
 * Maps an AI SDK step's tool results into our StepEvent shape, flagging failed
 * tool executions. ai@6 surfaces failures as `tool-error` content parts; we merge
 * those with `toolResults` so an errored tool is always recorded with isError.
 */
export function mapStepToolResults(
  step: any,
): { toolName: string; output: string; isError?: boolean }[] | undefined {
  const errorByName = new Map<string, string>();
  if (Array.isArray(step?.content)) {
    for (const part of step.content) {
      if (part?.type !== 'tool-error') continue;
      const raw =
        part.error instanceof Error
          ? part.error.message
          : typeof part.error === 'string'
            ? part.error
            : JSON.stringify(part.error ?? 'tool error');
      errorByName.set(part.toolName, String(raw).slice(0, TOOL_OUTPUT_LIMIT));
    }
  }

  const results: { toolName: string; output: string; isError?: boolean }[] = (
    step?.toolResults ?? []
  ).map((tr: any) => {
    const isError = errorByName.has(tr.toolName);
    const output =
      tr.toolName === 'request_secret'
        ? '[secret request initiated — url redacted from logs]'
        : isError
          ? errorByName.get(tr.toolName)!
          : String(tr.output ?? tr.result ?? '').slice(0, TOOL_OUTPUT_LIMIT);
    return isError ? { toolName: tr.toolName, output, isError: true } : { toolName: tr.toolName, output };
  });

  // Tool-error parts that produced no matching tool-result entry.
  for (const [toolName, output] of errorByName) {
    if (!results.some((r) => r.toolName === toolName)) {
      results.push({ toolName, output, isError: true });
    }
  }

  return results.length > 0 ? results : undefined;
}

export interface SpecialistEvent {
  id: string;
  kind: 'spawn' | 'complete' | 'error' | 'max_steps' | 'cancelled';
  specialistId: string;
  parentSessionId: string;
  taskDescription: string;
  timestamp: string;
  contextSnapshot?: string;
  result?: string;
  durationMs?: number;
  maxStepsUsed?: number;
  canResume?: boolean;
  background?: boolean;
  parentSpecialistId?: string;
  agentId?: string;
  modelUsed?: string;
}

// Merged per-specialist view (spawn + terminal event combined). No steps included.
// Safe to import with `import type` from client components.
export interface SpecialistSummary {
  specialistId: string;
  parentSessionId: string;
  taskDescription: string;
  contextSnapshot?: string;
  status: 'running' | 'complete' | 'error' | 'max_steps' | 'cancelled';
  result?: string;
  durationMs?: number;
  maxStepsUsed?: number;
  canResume?: boolean;
  background?: boolean;
  spawnedAt: string;
  parentSpecialistId?: string;
  agentId?: string;
  modelUsed?: string;
}

export interface ConversationMessageEvent {
  id: string;          // randomUUID() — stable event id
  rowId: number;       // DB primary key (conversations.id)
  chatId: string;
  agentId: string;
  messageId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;   // ISO timestamp
  turnId?: string;
}

export interface UserInputRequestEvent {
  id: string;
  inputId: string;
  chatId: string;
  prompt: string;
  options?: string[];
  timestamp: string;
}

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEvent {
  id: string;        // randomUUID() — stable React key
  ts: number;        // Date.now() — for HH:mm:ss.SSS display
  level: LogLevel;
  component: string; // extracted from [Tag] prefix, or 'system'
  message: string;   // message after stripping component prefix
  raw: string;       // full original string
}

// Stored on globalThis so HMR module re-evaluation doesn't create a second
// instance — the bot (instrumentation) and SSE route must share the same one.
declare global {
  // eslint-disable-next-line no-var
  var __logBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __specialistHistory: SpecialistEvent[] | undefined;
  // eslint-disable-next-line no-var
  var __logHistory: LogEvent[] | undefined;
}

if (!globalThis.__logBus) {
  globalThis.__logBus = new EventEmitter();
  globalThis.__logBus.setMaxListeners(50);
}

if (!globalThis.__specialistHistory) {
  globalThis.__specialistHistory = [];
}

if (!globalThis.__logHistory) {
  globalThis.__logHistory = [];
}

export const logBus = globalThis.__logBus;

export function getSpecialistHistory(): SpecialistEvent[] {
  return globalThis.__specialistHistory ?? [];
}

export function emitStep(event: StepEvent): void {
  // Stream live to subscribers (SSE), then persist durably to the DB.
  // Persistence is fire-and-forget so the agent hot path never blocks on it.
  logBus.emit('step', event);
  import('./orchestration-store')
    .then((m) => m.persistStepEvent(event))
    .catch((e) => console.error('[orchestration-store] persist step failed:', e));
}

export async function getStepHistory(
  sessionId?: string,
  agentId?: string,
  limit?: number,
  specialistId?: string,
): Promise<StepEvent[]> {
  const { loadChatSteps, loadRunSteps } = await import('./orchestration-store');
  if (specialistId) return loadRunSteps(specialistId);
  return loadChatSteps(sessionId, agentId, limit);
}

export function emitSpecialist(event: SpecialistEvent): void {
  // Keep a rolling buffer of the last 200 events for late-joining clients
  globalThis.__specialistHistory = [
    ...(globalThis.__specialistHistory ?? []).slice(-199),
    event,
  ];
  logBus.emit('specialist', event);
  import('./orchestration-store').then((m) => m.persistSpecialistEvent(event)).catch((e) => console.error('[orchestration-store] persist specialist failed:', e));
}

export async function getRunSteps(specialistId: string): Promise<StepEvent[]> {
  const { loadRunSteps } = await import('./orchestration-store');
  return loadRunSteps(specialistId);
}

export function emitUserInputRequest(event: UserInputRequestEvent): void {
  logBus.emit('user-input', event);
}

export function emitConversationMessage(event: ConversationMessageEvent): void {
  logBus.emit('conversation', event);
}

export function getLogHistory(): LogEvent[] {
  return globalThis.__logHistory ?? [];
}

export function emitLog(event: LogEvent): void {
  globalThis.__logHistory = [
    ...(globalThis.__logHistory ?? []).slice(-1999),
    event,
  ];
  logBus.emit('log', event);
}

// ─── Workflow Events ───────────────────────────────────────────────────────────

export interface WorkflowEvent {
  id: string;
  kind:
    | 'run_started'
    | 'node_started'
    | 'node_completed'
    | 'node_failed'
    | 'hitl_requested'
    | 'hitl_resolved'
    | 'run_completed'
    | 'run_failed';
  runId: string;
  workflowId: string;
  nodeId?: string;
  nodeType?: string;
  status?: string;
  result?: string;
  errorMessage?: string;
  chatId?: string;
  durationMs?: number;
  timestamp: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __workflowHistory: WorkflowEvent[] | undefined;
}

if (!globalThis.__workflowHistory) {
  globalThis.__workflowHistory = [];
}

export function emitWorkflow(event: WorkflowEvent): void {
  globalThis.__workflowHistory = [
    ...(globalThis.__workflowHistory ?? []).slice(-199),
    event,
  ];
  logBus.emit('workflow', event);
}

export function getWorkflowHistory(): WorkflowEvent[] {
  return globalThis.__workflowHistory ?? [];
}
