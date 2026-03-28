import { EventEmitter } from 'node:events';
import { configManager } from '../config';

export interface StepEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  stepIndex: number;
  finishReason: string;
  text?: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; output: string }[];
  ragContext?: string;
  agentId?: string;
  specialistId?: string;
}

export interface SpecialistEvent {
  id: string;
  kind: 'spawn' | 'complete' | 'error' | 'max_steps';
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
  // eslint-disable-next-line no-var
  var __stepHistory: StepEvent[] | undefined;
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

if (!globalThis.__stepHistory) {
  globalThis.__stepHistory = [];
}

export const logBus = globalThis.__logBus;

function getToolCallMemoryLimit(): number {
  const cfgLimit = configManager.get().tools?.toolCallMemoryLimit;
  if (typeof cfgLimit !== 'number' || Number.isNaN(cfgLimit)) return 500;
  return Math.min(Math.max(cfgLimit, 0), 5000);
}

export function getSpecialistHistory(): SpecialistEvent[] {
  return globalThis.__specialistHistory ?? [];
}

export function emitStep(event: StepEvent): void {
  const limit = getToolCallMemoryLimit();
  if (limit > 0) {
    const history = globalThis.__stepHistory ?? [];
    globalThis.__stepHistory = [...history.slice(-(limit - 1)), event];
  }
  logBus.emit('step', event);
}

export function getStepHistory(sessionId?: string, agentId?: string, limit?: number, specialistId?: string): StepEvent[] {
  const history = (globalThis.__stepHistory ?? []).filter((event) => {
    if (sessionId && event.sessionId !== sessionId) return false;
    if (agentId && event.agentId !== agentId) return false;
    if (specialistId && event.specialistId !== specialistId) return false;
    return true;
  });

  const effectiveLimit = typeof limit === 'number' && !Number.isNaN(limit) ? limit : getToolCallMemoryLimit();
  if (effectiveLimit <= 0) return [];
  return history.slice(-effectiveLimit);
}

export function emitSpecialist(event: SpecialistEvent): void {
  // Keep a rolling buffer of the last 200 events for late-joining clients
  globalThis.__specialistHistory = [
    ...(globalThis.__specialistHistory ?? []).slice(-199),
    event,
  ];
  logBus.emit('specialist', event);
}

export function emitUserInputRequest(event: UserInputRequestEvent): void {
  logBus.emit('user-input', event);
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
