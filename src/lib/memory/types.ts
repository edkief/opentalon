export type MemoryScope = 'private' | 'shared';

export interface MemoryPayload {
  chat_id: string;
  scope: MemoryScope;
  // 'note' = a fact the agent deliberately committed to retrievable memory via
  // memory_append store:'recall' (episodic content kept out of Core Memory, #21).
  author: 'user' | 'assistant' | 'exchange' | 'note';
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
  author: 'user' | 'exchange' | 'note';
  text: string;
  agent?: string; // Optional: tag memory with agent name
}
