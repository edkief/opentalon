import type { GenerateTextResult, ToolSet } from 'ai';
import type { MemoryScope } from '../memory';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ExecutorConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatOptions {
  messages: Message[];
  context?: string;
  memoryScope?: MemoryScope;
  chatId?: string;
  tools?: ToolSet;
  maxSteps?: number;
  agentId?: string;
  modelOverride?: string;
  specialistId?: string;
  /** Groups this turn's user message, intermediate steps, and assistant reply. */
  turnId?: string;
  /**
   * Run ID used solely to tag emitted step events for orchestration persistence
   * (e.g. scheduled cron-task runs). Unlike `specialistId`, this does NOT trigger
   * cancellation registration or fork-and-wait prompt injection.
   */
  orchestrationRunId?: string;
  abortSignal?: AbortSignal;
  /** Job IDs spawned during this turn — limits awaitPendingSpecialists to only these. */
  turnJobIds?: Set<string>;
}

export type { GenerateTextResult };

export type ChatResponse =
  | { type: 'text'; text: string; result: GenerateTextResult<any, any>; provider?: string; hitMaxSteps?: boolean; maxStepsUsed?: number; turnId?: string }
  | { type: 'error'; error: string };

/** Narrow helper — true when the response has a final text */
export function isChatText(r: ChatResponse): r is Extract<ChatResponse, { type: 'text' }> {
  return r.type === 'text';
}
