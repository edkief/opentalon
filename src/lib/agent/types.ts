import type { GenerateTextResult } from 'ai';
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
}

export type { GenerateTextResult };

export interface ChatResponse {
  text: string;
  result: GenerateTextResult<any, any>;
}
