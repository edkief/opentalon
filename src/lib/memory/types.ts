export type MemoryScope = 'private' | 'shared';

export interface MemoryPayload {
  chat_id: string;
  scope: MemoryScope;
  author: 'user' | 'assistant' | 'exchange';
  timestamp: number;
  text: string;
  agent?: string;
}

export interface MemoryResult {
  id: string;
  score: number;
  payload: MemoryPayload;
}

export interface RetrieveOptions {
  query: string;
  scope: MemoryScope;
  limit?: number;
  chatId?: string; // Optional: to exclude current chat from results
  agent?: string; // Optional: filter by agent (non-default only)
}

export interface IngestOptions {
  chatId: string;
  scope: MemoryScope;
  author: 'user' | 'exchange';
  text: string;
  agent?: string; // Optional: tag memory with agent name
}
