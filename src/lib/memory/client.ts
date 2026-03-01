import { QdrantClient } from '@qdrant/js-client-rest';
import { getEmbeddingDimension } from './embeddings';

const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
const qdrantApiKey = process.env.QDRANT_API_KEY || undefined;

export const qdrantClient = new QdrantClient({
  url: qdrantUrl,
  apiKey: qdrantApiKey,
});

export const COLLECTION_NAME = 'openpincer_memory';

export async function ensureCollection(): Promise<void> {
  console.log('[Memory] ensureCollection called');

  try {
    console.log('[Memory] Calling collectionExists...');
    const result = await qdrantClient.collectionExists(COLLECTION_NAME);
    console.log('[Memory] collectionExists result:', JSON.stringify(result));

    if (result.exists) {
      console.log('[Memory] Collection already exists');
      return;
    }

    console.log('[Memory] Collection does not exist, creating...');
    const dimension = getEmbeddingDimension();
    console.log(`[Memory] Creating collection with ${dimension} dims + sparse vectors...`);

    await qdrantClient.createCollection(COLLECTION_NAME, {
      vectors: {
        dense: {
          size: dimension,
          distance: 'Cosine',
          on_disk: true,
        },
      },
      sparse_vectors: {
        sparse: {
          modifier: 'idf',
        },
      },
    });
    console.log('[Memory] Collection created successfully');
  } catch (error) {
    console.error('[Memory] Failed to ensure collection:', error);
    throw error;
  }
}

// Shared singleton promise — prevents duplicate init calls from concurrent ingest/retrieve
let initPromise: Promise<void> | null = null;

export async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = ensureCollection().catch((err) => {
      // Reset on failure so the next call retries
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}
