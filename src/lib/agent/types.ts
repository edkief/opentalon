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
  /**
   * True when this turn is the body of a stateless background specialist.
   * Disables Core Memory injection, automatic RAG retrieval, and any memory
   * policy; the supervisor is responsible for pre-loading relevant context
   * into the task user message (and/or `supervisorContext`). Defaults to false.
   */
  statelessSpecialist?: boolean;
  /**
   * Optional supervisor-handoff context for a stateless specialist. When set,
   * prepended to the task user message under a `## Context from Supervisor`
   * section so the model sees it directly without needing Core Memory or RAG.
   */
  supervisorContext?: string;
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
  /**
   * True when this turn was triggered by a fresh user message (Telegram/web chat),
   * as opposed to an automated run (cron, background specialist, synthesis turn).
   * Gates the todo fresh-start policy: a leftover todo list from a previous turn
   * is cleared at the start of a user-initiated turn unless background specialist
   * jobs are still running for the chat (the only case where cross-turn todo
   * persistence is intended).
   */
  userInitiated?: boolean;
  /**
   * Crash-recovery replay: tool activity this turn had already executed before a
   * restart, as AI SDK messages (assistant tool-call + tool-result pairs). When
   * set, these are appended after the user message so the model continues from
   * where it stopped instead of redoing executed work. Built by
   * reconstructTurnMessages() from persisted conversation_steps. See
   * src/lib/agent/resume.ts.
   */
  resumeMessages?: ModelMessage[];
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
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
  };
  toolCalls?: StepToolCallView[];
  toolResults?: StepToolResultView[];
}

export interface GenerationResult {
  text: string;
  steps: StepView[];
  /** Usage of the FINAL step only (AI SDK v5+). For whole-turn totals use `totalUsage`. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
  };
  /** Aggregated usage summed across every step of the turn — the value to persist. */
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
  };
  response?: { messages: ModelMessage[] };
}

export type ChatResponse =
  | { type: 'text'; text: string; /** Absent when the turn was force-cancelled — no generation completed. */ result?: GenerationResult; provider?: string; hitMaxSteps?: boolean; maxStepsUsed?: number; turnId?: string; responseMessages?: ModelMessage[]; cancelled?: boolean }
  | { type: 'error'; error: string };

/** Narrow helper — true when the response has a final text */
export function isChatText(r: ChatResponse): r is Extract<ChatResponse, { type: 'text' }> {
  return r.type === 'text';
}
