import { generateObject } from 'ai';
import { z } from 'zod';
import { qdrantClient } from './client';
import { generateEmbedding, generateSparseVector, getEmbeddingProvider, getEmbeddingDimension } from './embeddings';
import { resolveModelList } from '../agent/model-resolver';
import { configManager } from '../config';
import type { MemoryScope } from './types';

/**
 * #27: conversation-history semantic index. This is a SEPARATE Qdrant collection
 * from the recall store (`opentalon_memory`). Keeping history hits out of
 * memory_recall (and vice versa) is enforced by construction — different
 * collection — not by filter discipline.
 *
 * The collection holds a one-line GIST per conversation turn (dense+sparse
 * vectors over the gist) plus a payload pointer back into Postgres. Postgres
 * stays the source of truth for verbatim content; this is only the index.
 */
export const HISTORY_COLLECTION_NAME = 'opentalon_history';

export interface HistoryPayload {
  turn_id: string;
  chat_id: string;
  agent: string;
  scope: MemoryScope;
  timestamp: number;
  gist: string;
}

export interface TurnGist {
  gist: string;
  concepts: string[];
}

// ── Collection lifecycle ────────────────────────────────────────────────────

let historyInitPromise: Promise<void> | null = null;

async function ensureHistoryPayloadIndexes(): Promise<void> {
  for (const field of ['chat_id', 'agent', 'scope'] as const) {
    try {
      await qdrantClient.createPayloadIndex(HISTORY_COLLECTION_NAME, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
    } catch {
      // Already exists — idempotent.
    }
  }
}

export async function ensureHistoryCollection(): Promise<void> {
  const exists = await qdrantClient.collectionExists(HISTORY_COLLECTION_NAME);
  if (!exists.exists) {
    const dimension = getEmbeddingDimension();
    console.log(`[History] Creating collection ${HISTORY_COLLECTION_NAME} (${dimension} dims + sparse)...`);
    await qdrantClient.createCollection(HISTORY_COLLECTION_NAME, {
      vectors: { dense: { size: dimension, distance: 'Cosine', on_disk: true } },
      sparse_vectors: { sparse: { modifier: 'idf' } },
    });
  }
  await ensureHistoryPayloadIndexes();
}

export async function ensureHistoryInitialized(): Promise<void> {
  if (!historyInitPromise) {
    historyInitPromise = ensureHistoryCollection().catch((err) => {
      historyInitPromise = null;
      throw err;
    });
  }
  return historyInitPromise;
}

/**
 * Best-effort scope for a chat when the true scope isn't carried (backfill of
 * historical rows, which don't store scope). Telegram group/supergroup chat IDs
 * are negative → 'shared'; DMs, 'web', and 'email:*' are 'private'. Live gist
 * jobs pass the real scope and never rely on this.
 */
export function inferScopeFromChatId(chatId: string): MemoryScope {
  return /^-/.test(chatId) ? 'shared' : 'private';
}

// ── Gist generation (cheap-model pass) ──────────────────────────────────────

/**
 * Resolve the model used for gist generation. Reuses the aux-model routing
 * config (llm.auxModel) — these are cheap, constrained summarisation calls, not
 * conversational turns. Falls back to the primary model when auxModel is unset.
 */
function resolveGistModel() {
  const cfg = configManager.get().llm ?? {};
  const [resolved] = resolveModelList(cfg.auxModel ?? cfg.model, []);
  if (!resolved) throw new Error('[History] No model available for gist generation');
  return resolved;
}

const gistSchema = z.object({
  gist: z.string().describe('A single concise sentence capturing what this conversation turn was about.'),
  concepts: z.array(z.string()).describe('3-6 freeform keywords/entities central to the turn (names, systems, error strings, topics).'),
});

/**
 * Summarise-then-embed: turn the raw "User: …\nAssistant: …" blob into a one-line
 * gist + a few concept keywords. Raw turns embed poorly (long, multi-topic,
 * boilerplate-heavy); a one-line gist embeds well and the keywords feed the
 * sparse/BM25 leg. There is deliberately no fixed taxonomy — turns are too
 * heterogeneous for an enum.
 */
export async function generateTurnGist(turnText: string): Promise<TurnGist | null> {
  const trimmed = turnText.trim();
  if (!trimmed) return null;
  try {
    const { model } = resolveGistModel();
    const { object } = await generateObject({
      model,
      schema: gistSchema,
      temperature: 0.2,
      prompt:
        'Summarise the following conversation turn for a searchable history index. ' +
        'Produce a one-sentence gist and a few concept keywords. Be factual and specific ' +
        '(prefer concrete names, systems, and error strings over generic words).\n\n' +
        '--- TURN ---\n' +
        trimmed.slice(0, 8000),
    });
    return { gist: object.gist.trim(), concepts: object.concepts.map((c) => c.trim()).filter(Boolean) };
  } catch (err) {
    console.error('[History] Gist generation failed:', err);
    return null;
  }
}

// ── Indexing ────────────────────────────────────────────────────────────────

export interface IndexTurnOptions {
  turnId: string;
  chatId: string;
  agent: string;
  scope: MemoryScope;
  timestamp: number;
  turnText: string;
}

/**
 * Generate a gist for a turn and upsert it into the history collection. The
 * point ID is the turnId (a UUID), so re-indexing the same turn overwrites
 * rather than duplicating — this makes the backfill idempotent/resumable.
 * Returns true if a point was written.
 */
export async function indexTurnGist(opts: IndexTurnOptions): Promise<boolean> {
  const { turnId, chatId, agent, scope, timestamp, turnText } = opts;
  if (!turnId) return false;

  const gist = await generateTurnGist(turnText);
  if (!gist) return false;

  try {
    await ensureHistoryInitialized();
    const provider = getEmbeddingProvider();
    // Dense over the gist; sparse over gist + concepts (the BM25 leg).
    const sparseText = [gist.gist, ...gist.concepts].join(' ');
    const [denseVector, sparseVector] = await Promise.all([
      generateEmbedding(gist.gist, provider),
      Promise.resolve(generateSparseVector(sparseText)),
    ]);

    const payload: HistoryPayload = { turn_id: turnId, chat_id: chatId, agent, scope, timestamp, gist: gist.gist };

    await qdrantClient.upsert(HISTORY_COLLECTION_NAME, {
      wait: true,
      points: [{ id: turnId, vector: { dense: denseVector, sparse: sparseVector }, payload: payload as unknown as Record<string, unknown> }],
    });
    return true;
  } catch (err) {
    console.error('[History] Failed to index turn gist:', err);
    return false;
  }
}

/**
 * Look up the stored scope for a set of turns from the gist index. Used to
 * enforce the scope boundary on cross-chat keyword (FTS) hits, which come from
 * Postgres where scope is not stored. Turns with no gist point are absent from
 * the map (and are therefore excluded from cross-chat results).
 */
export async function getHistoryScopes(turnIds: string[]): Promise<Map<string, MemoryScope>> {
  const out = new Map<string, MemoryScope>();
  if (turnIds.length === 0) return out;
  try {
    await ensureHistoryInitialized();
    const points = await qdrantClient.retrieve(HISTORY_COLLECTION_NAME, { ids: turnIds, with_payload: true });
    for (const p of points) {
      const payload = p.payload as unknown as HistoryPayload;
      if (payload?.turn_id && payload?.scope) out.set(payload.turn_id, payload.scope);
    }
  } catch (err) {
    console.error('[History] Failed to look up scopes:', err);
  }
  return out;
}

/** Whether a turn already has a gist point (used to skip work during backfill). */
export async function isTurnIndexed(turnId: string): Promise<boolean> {
  try {
    await ensureHistoryInitialized();
    const points = await qdrantClient.retrieve(HISTORY_COLLECTION_NAME, { ids: [turnId], with_payload: false });
    return points.length > 0;
  } catch {
    return false;
  }
}

// ── Vector retrieval leg (over gists) ───────────────────────────────────────

export interface HistoryVectorHit {
  turnId: string;
  score: number;
  gist: string;
}

export interface HistoryVectorSearchOptions {
  query: string;
  scope: MemoryScope;
  chatId?: string; // when set, restrict to this chat (chat_scope: 'current')
  agent?: string;
  limit: number;
}

/**
 * Vector leg of history_search: dense+sparse search over gists, fused with RRF.
 * Returns turn pointers (turnId) for hydration from Postgres — never the gist
 * as the answer. Unlike the recall store, history IS chat-scopable (a caller may
 * want "in this conversation" vs "everywhere").
 */
export async function searchHistoryVectors(opts: HistoryVectorSearchOptions): Promise<HistoryVectorHit[]> {
  const { query, scope, chatId, agent, limit } = opts;
  if (!query.trim()) return [];

  await ensureHistoryInitialized();
  const provider = getEmbeddingProvider();
  const [denseVector, sparseVector] = await Promise.all([
    generateEmbedding(query, provider),
    Promise.resolve(generateSparseVector(query)),
  ]);

  const must: unknown[] = [{ key: 'scope', match: { value: scope } }];
  if (chatId) must.push({ key: 'chat_id', match: { value: chatId } });
  if (agent) must.push({ key: 'agent', match: { value: agent } });
  const filter = { must };

  const candidateLimit = limit * 4;
  const [denseResults, sparseResults] = await Promise.all([
    qdrantClient.search(HISTORY_COLLECTION_NAME, {
      vector: { name: 'dense', vector: denseVector },
      filter,
      limit: candidateLimit,
      with_payload: true,
    }),
    qdrantClient.search(HISTORY_COLLECTION_NAME, {
      vector: { name: 'sparse', vector: sparseVector } as Parameters<typeof qdrantClient.search>[1]['vector'],
      filter,
      limit: candidateLimit,
      with_payload: true,
    }),
  ]);

  const RRF_K = 60;
  const scoreMap = new Map<string, number>();
  const gistMap = new Map<string, string>();
  const rankMerge = (results: typeof denseResults) => {
    results.forEach((r, rank) => {
      const p = r.payload as unknown as HistoryPayload;
      const turnId = p?.turn_id ?? String(r.id);
      scoreMap.set(turnId, (scoreMap.get(turnId) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!gistMap.has(turnId)) gistMap.set(turnId, p?.gist ?? '');
    });
  };
  rankMerge(denseResults);
  rankMerge(sparseResults);

  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([turnId, score]) => ({ turnId, score, gist: gistMap.get(turnId) ?? '' }));
}
