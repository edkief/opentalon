export type MemoryScope = 'private' | 'shared';

/**
 * Recall taxonomy (#26). Defined in CODE as the single source of truth so the
 * LLM cannot drift the vocabulary (inventing `formatting` one turn, `code_style`
 * the next) — the z.enum on the memory_append input schema IS the enforcement,
 * same pattern as the existing `store` enum. Covers EPISODIC content only:
 * preferences and standing rules belong in Core Memory (MEMORY.md), NOT here.
 */
export const RECALL_CATEGORIES = ['finding', 'event', 'entity_fact', 'gotcha'] as const;
export type RecallCategory = (typeof RECALL_CATEGORIES)[number];

/** Human-readable meaning of each category — surfaced in tool descriptions. */
export const RECALL_CATEGORY_DESCRIPTIONS: Record<RecallCategory, string> = {
  finding: 'analysis results, conclusions',
  event: 'dated occurrences',
  entity_fact: 'a learned fact about a system, person, or thing',
  gotcha: 'a non-obvious pitfall and its resolution',
};

export const DEFAULT_RECALL_CATEGORY: RecallCategory = 'finding';

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
  category?: RecallCategory; // #26: episodic taxonomy, defaults to 'finding'
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
  category?: RecallCategory; // #26: optional category filter
}

export interface IngestOptions {
  chatId: string;
  scope: MemoryScope;
  text: string;
  agent?: string; // Optional: tag memory with agent name
  category?: RecallCategory; // #26: episodic taxonomy, defaults to 'finding'
}
