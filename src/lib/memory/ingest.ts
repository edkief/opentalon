import { qdrantClient, COLLECTION_NAME, ensureInitialized, SCHEMA_MARKER_ID } from './client';
import { generateEmbedding, generateSparseVector, getEmbeddingProvider } from './embeddings';
import { DEFAULT_RECALL_CATEGORY } from './types';
import type { IngestOptions, MemoryPayload } from './types';
import { agentRegistry } from '../soul';

/**
 * Store a note in the recall vector store. Returns the new point's ID (#26) so
 * callers (memory_append) can surface it for a later supersede/delete, or null
 * if nothing was stored (empty text) or the write failed.
 */
export async function ingestMemory(options: IngestOptions): Promise<string | null> {
  const { chatId, scope, text, agent, category } = options;

  if (!text.trim()) return null;

  try {
    await ensureInitialized();

    const provider = getEmbeddingProvider();
    const [denseVector, sparseVector] = await Promise.all([
      generateEmbedding(text, provider),
      Promise.resolve(generateSparseVector(text)),
    ]);

    const payload: MemoryPayload = {
      chat_id: chatId,
      scope,
      timestamp: Date.now(),
      text,
      category: category ?? DEFAULT_RECALL_CATEGORY,
      ...(agent && !agentRegistry.isDefaultAgent(agent) ? { agent } : {}),
    };

    const id = crypto.randomUUID();
    const point = {
      id,
      vector: {
        dense: denseVector,
        sparse: sparseVector,
      },
      payload: payload as unknown as Record<string, unknown>,
    };

    await qdrantClient.upsert(COLLECTION_NAME, {
      wait: true,
      points: [point],
    });

    console.log(`[Memory] Stored: "${text.substring(0, 50)}..." (category: ${payload.category}, provider: ${provider})`);
    return id;
  } catch (error) {
    console.error('[Memory] Failed to ingest:', error);
    return null;
  }
}

/**
 * Delete a recall note by point ID (#26 supersede path). Returns true on
 * success. Refuses to delete the reserved schema-marker point.
 */
export async function deleteRecallMemory(id: string): Promise<boolean> {
  if (id === SCHEMA_MARKER_ID) return false;
  try {
    await ensureInitialized();
    await qdrantClient.delete(COLLECTION_NAME, { wait: true, points: [id] });
    return true;
  } catch (error) {
    console.error('[Memory] Failed to delete recall note:', error);
    return false;
  }
}
