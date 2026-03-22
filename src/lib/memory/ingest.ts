import { qdrantClient, COLLECTION_NAME, ensureInitialized } from './client';
import { generateEmbedding, generateSparseVector, getEmbeddingProvider } from './embeddings';
import type { IngestOptions, MemoryPayload } from './types';

export async function ingestMemory(options: IngestOptions): Promise<void> {
  const { chatId, scope, author, text, agent } = options;

  if (!text.trim()) return;

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
      author,
      timestamp: Date.now(),
      text,
      ...(agent && agent !== 'default' ? { agent } : {}),
    };

    const point = {
      id: crypto.randomUUID(),
      vector: {
        dense: denseVector,
        sparse: sparseVector,
      },
      payload: payload as unknown as Record<string, unknown>,
    };

    await qdrantClient.upsert(COLLECTION_NAME, {
      wait: false,
      points: [point],
    });

    console.log(`[Memory] Stored: "${text.substring(0, 50)}..." (provider: ${provider})`);
  } catch (error) {
    console.error('[Memory] Failed to ingest:', error);
  }
}
