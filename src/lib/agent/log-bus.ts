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
}

export interface SpecialistEvent {
  id: string;
  kind: 'spawn' | 'complete' | 'error';
  specialistId: string;
  parentSessionId: string;
  taskDescription: string;
  timestamp: string;
  contextSnapshot?: string;
  result?: string;
  durationMs?: number;
}

// Stored on globalThis so HMR module re-evaluation doesn't create a second
// instance — the bot (instrumentation) and SSE route must share the same one.
declare global {
  // eslint-disable-next-line no-var
  var __logBus: EventEmitter | undefined;
}

if (!globalThis.__logBus) {
  globalThis.__logBus = new EventEmitter();
  globalThis.__logBus.setMaxListeners(50);
}

export const logBus = globalThis.__logBus;

export function emitStep(event: AgentStepEvent): void {
  logBus.emit('step', event);
}

export function emitSpecialist(event: SpecialistEvent): void {
  logBus.emit('specialist', event);
}
