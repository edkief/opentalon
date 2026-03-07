import { EventEmitter } from 'node:events';

export interface AgentStepEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  stepIndex: number;
  finishReason: string;
  text?: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; output: string }[];
  ragContext?: string;
  personaId?: string;
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

export function emitStep(event: AgentStepEvent): void {
  logBus.emit('step', event);
}

export function emitSpecialist(event: SpecialistEvent): void {
  // Keep a rolling buffer of the last 200 events for late-joining clients
  globalThis.__specialistHistory = [
    ...(globalThis.__specialistHistory ?? []).slice(-199),
    event,
  ];
  logBus.emit('specialist', event);
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
