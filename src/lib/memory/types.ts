export type MemoryScope = 'private' | 'shared';

export interface MemoryPayload {
  chat_id: string;
  scope: MemoryScope;
  author: 'user' | 'assistant';
  timestamp: number;
  text: string;
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
}

export interface IngestOptions {
  chatId: string;
  scope: MemoryScope;
  author: 'user' | 'assistant';
  text: string;
}
