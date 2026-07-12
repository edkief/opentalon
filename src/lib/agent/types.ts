import type { GenerateTextResult, ModelMessage, ToolSet } from 'ai';
import type { MemoryScope } from '../memory';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * For assistant messages replayed from history: the turn's AI SDK
   * response.messages (assistant tool-call parts + tool-result messages),
   * minus the trailing plain-text assistant message (represented by
   * `content`). Undefined for user/system messages and legacy rows.
   */
  parts?: ModelMessage[];
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

/**
 * Structural view over the parts of a generation result the executor and its
 * consumers actually read. Both generation paths satisfy it: the classic
 * `generateText` result (a full `GenerateTextResult`) and the progressive
 * streamed result (a subset). ai@6 (AI SDK v5+) always uses `input`/`output` —
 * the v4-era `args`/`result` aliases have been removed.
 */
export interface StepToolCallView {
  toolName: string;
  input?: unknown;
}

export interface StepToolResultView {
  toolName: string;
  output?: unknown;
}

export interface StepView {
  finishReason: string;
  text?: string;
  reasoningText?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: StepToolCallView[];
  toolResults?: StepToolResultView[];
}

export interface GenerationResult {
  text: string;
  steps: StepView[];
  usage?: { inputTokens?: number; outputTokens?: number };
  response?: { messages: ModelMessage[] };
}

export type ChatResponse =
  | { type: 'text'; text: string; result: GenerationResult; provider?: string; hitMaxSteps?: boolean; maxStepsUsed?: number; turnId?: string; responseMessages?: ModelMessage[] }
  | { type: 'error'; error: string };

/** Narrow helper — true when the response has a final text */
export function isChatText(r: ChatResponse): r is Extract<ChatResponse, { type: 'text' }> {
  return r.type === 'text';
}
