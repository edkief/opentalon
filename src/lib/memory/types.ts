export type MemoryScope = 'private' | 'shared';

export interface MemoryPayload {
  chat_id: string;
  scope: MemoryScope;
  // Every point in this collection is a note the agent deliberately committed
  // to retrievable memory via memory_append store:'recall' (#24 retired the
  // automatic per-turn ingestion of user/assistant/exchange turns). There is no
  // longer an `author` field — it carried no information once every point is a note.
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
  // NOTE (#25): notes are intentionally recalled ACROSS chats. The privacy
  // boundary is `scope` (private/shared) + agent tag, not the originating chat —
  // a note learned in one private DM with the owner is legitimately recallable
  // in another. There is deliberately no chat_id filter here. (chat_id remains
  // on the payload for provenance display only.)
  agent?: string; // Optional: filter by agent (non-default only)
}

export interface IngestOptions {
  chatId: string;
  scope: MemoryScope;
  text: string;
  agent?: string; // Optional: tag memory with agent name
}
