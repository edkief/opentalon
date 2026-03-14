export type MemoryScope = 'private' | 'shared';

export interface MemoryPayload {
  chat_id: string;
  scope: MemoryScope;
  author: 'user' | 'assistant' | 'exchange';
  timestamp: number;
  text: string;
  persona?: string;
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
  persona?: string; // Optional: filter by persona (non-default only)
}

export interface IngestOptions {
  chatId: string;
  scope: MemoryScope;
  author: 'user' | 'exchange';
  text: string;
  persona?: string; // Optional: tag memory with persona name
}
