import { qdrantClient, COLLECTION_NAME, ensureInitialized } from './client';
import { generateEmbedding, generateSparseVector, getEmbeddingProvider } from './embeddings';
import type { RetrieveOptions } from './types';

const RRF_K = 60;

function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

export async function retrieveContext(options: RetrieveOptions): Promise<string> {
  const { query, scope, limit = 5, chatId, persona } = options;

  if (!query.trim()) return '';

  try {
    await ensureInitialized();

    const provider = getEmbeddingProvider();
    const [denseVector, sparseVector] = await Promise.all([
      generateEmbedding(query, provider),
      Promise.resolve(generateSparseVector(query)),
    ]);

    // Scope is always required; chatId narrows results to the current chat's history
    const mustConditions: unknown[] = [
      { key: 'scope', match: { value: scope } },
    ];

    if (chatId) {
      mustConditions.push({ key: 'chat_id', match: { value: chatId } });
    }

    // For non-default personas, only return memories tagged with that persona.
    // For default (or when persona is absent), no filter is applied so legacy
    // untagged memories are still returned (backward-compatible).
    if (persona && persona !== 'default') {
      mustConditions.push({ key: 'persona', match: { value: persona } });
    }

    const filter = { must: mustConditions };
    const candidateLimit = limit * 4; // Over-fetch for RRF reranking

    // Run dense and sparse searches in parallel
    const [denseResults, sparseResults] = await Promise.all([
      qdrantClient.search(COLLECTION_NAME, {
        vector: { name: 'dense', vector: denseVector },
        filter,
        limit: candidateLimit,
        with_payload: true,
      }),
      qdrantClient.search(COLLECTION_NAME, {
        vector: { name: 'sparse', vector: sparseVector } as any,
        filter,
        limit: candidateLimit,
        with_payload: true,
      }),
    ]);

    // Reciprocal Rank Fusion
    const scoreMap = new Map<string, number>();
    const resultMap = new Map<string, (typeof denseResults)[number]>();

    denseResults.forEach((result, rank) => {
      const id = String(result.id);
      scoreMap.set(id, (scoreMap.get(id) ?? 0) + rrfScore(rank));
      resultMap.set(id, result);
    });

    sparseResults.forEach((result, rank) => {
      const id = String(result.id);
      scoreMap.set(id, (scoreMap.get(id) ?? 0) + rrfScore(rank));
      if (!resultMap.has(id)) resultMap.set(id, result);
    });

    const merged = [...scoreMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => resultMap.get(id)!)
      .filter(Boolean);

    if (merged.length === 0) return '';

    return merged
      .map((result) => {
        const payload = result.payload as Record<string, unknown>;
        return `[${payload.author}]: ${payload.text}`;
      })
      .join('\n\n');
  } catch (error) {
    console.error('[Memory] Failed to retrieve:', error);
    return '';
  }
}

export { retrieveContext as getRelatedContext };
