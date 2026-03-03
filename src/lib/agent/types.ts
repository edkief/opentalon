import type { GenerateTextResult, ToolSet } from 'ai';
import type { MemoryScope } from '../memory';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentConfig {
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
  personaId?: string;
}

export type { GenerateTextResult };

export type ChatResponse =
  | { type: 'text'; text: string; result: GenerateTextResult<any, any>; provider?: string }
  | { type: 'error'; error: string };

/** Narrow helper — true when the response has a final text */
export function isChatText(r: ChatResponse): r is Extract<ChatResponse, { type: 'text' }> {
  return r.type === 'text';
}
