import { QdrantClient } from '@qdrant/js-client-rest';
import { getEmbeddingDimension } from './embeddings';

const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
const qdrantApiKey = process.env.QDRANT_API_KEY || undefined;

export const qdrantClient = new QdrantClient({
  url: qdrantUrl,
  apiKey: qdrantApiKey,
});

export const COLLECTION_NAME = 'opentalon_memory';

// Schema version for the recall collection. Bump this whenever the payload
// shape or indexing changes in a way that makes existing points invalid. On
// startup, a collection whose stored version differs is DROPPED and recreated
// fresh — there is no legacy-read compatibility (#24: existing points are
// agreed non-valuable; #26: keyword payload indexes baked in at creation).
//
// v2 (#24): retired automatic per-turn ingestion and dropped the `author`
// payload field; every point is now an agent-written note. Existing v1 data is
// wiped on deploy.
export const COLLECTION_SCHEMA_VERSION = 2;

// A reserved point that records the collection's schema version. Qdrant has no
// collection-level metadata, so we persist the version on a single sentinel
// point with a fixed UUID. It carries no `scope`/`agent`/`text`, so the
// scope-required retrieval filter never returns it. Exported so listing/curation
// paths (e.g. the dashboard scroll) can exclude it explicitly.
export const SCHEMA_MARKER_ID = '00000000-0000-0000-0000-000000000001';

async function readSchemaVersion(): Promise<number | null> {
  try {
    const points = await qdrantClient.retrieve(COLLECTION_NAME, {
      ids: [SCHEMA_MARKER_ID],
      with_payload: true,
    });
    const marker = points[0];
    const version = marker?.payload?.schema_version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

async function createCollectionFresh(): Promise<void> {
  const dimension = getEmbeddingDimension();
  console.log(`[Memory] Creating collection ${COLLECTION_NAME} (schema v${COLLECTION_SCHEMA_VERSION}) with ${dimension} dims + sparse vectors...`);

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

  await ensurePayloadIndexes();

  // Stamp the schema version on the sentinel point. It needs a vector to exist;
  // a zero dense vector is fine — it never matches a real query and is excluded
  // from retrieval by the scope-required filter.
  await qdrantClient.upsert(COLLECTION_NAME, {
    wait: true,
    points: [
      {
        id: SCHEMA_MARKER_ID,
        vector: { dense: new Array(dimension).fill(0) },
        payload: { schema_version: COLLECTION_SCHEMA_VERSION },
      },
    ],
  });

  console.log('[Memory] Collection created successfully');
}

// Keyword payload indexes for the fields every query filters on (#26). Idempotent:
// Qdrant returns an error if the index already exists, which we swallow so this
// is safe to call on every startup.
async function ensurePayloadIndexes(): Promise<void> {
  const fields = ['scope', 'agent', 'category'] as const;
  for (const field of fields) {
    try {
      await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: 'keyword',
        wait: true,
      });
    } catch {
      // Index already exists (or concurrent creation) — non-fatal.
    }
  }
}

export async function ensureCollection(): Promise<void> {
  console.log('[Memory] ensureCollection called');

  try {
    const result = await qdrantClient.collectionExists(COLLECTION_NAME);

    if (result.exists) {
      const version = await readSchemaVersion();
      if (version === COLLECTION_SCHEMA_VERSION) {
        // Up to date. Re-assert payload indexes in case a prior startup created
        // the collection before indexes were introduced.
        await ensurePayloadIndexes();
        return;
      }
      console.log(`[Memory] Collection schema v${version ?? 'unknown'} != v${COLLECTION_SCHEMA_VERSION}; dropping and recreating (data is not migrated).`);
      await qdrantClient.deleteCollection(COLLECTION_NAME);
    } else {
      console.log('[Memory] Collection does not exist, creating...');
    }

    await createCollectionFresh();
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
