export type EmbeddingProvider = 'openai' | 'fastembed';

export interface SparseVector {
  indices: number[];
  values: number[];
}

export async function generateEmbedding(
  text: string,
  provider: EmbeddingProvider = 'openai'
): Promise<number[]> {
  if (provider === 'fastembed') {
    return generateFastEmbedEmbedding(text);
  }
  return generateOpenAIEmbedding(text);
}

/**
 * Generates a BM25-style sparse vector via TF tokenization.
 * Qdrant applies IDF weighting at search time (modifier: idf).
 */
export function generateSparseVector(text: string): SparseVector {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  const freq = new Map<number, number>();
  for (const token of tokens) {
    const idx = hashToken(token);
    freq.set(idx, (freq.get(idx) || 0) + 1);
  }

  const total = tokens.length;
  const indices: number[] = [];
  const values: number[] = [];

  for (const [idx, count] of freq.entries()) {
    indices.push(idx);
    values.push(count / total);
  }

  return { indices, values };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
}

// djb2-style hash, bounded to positive integer index space
function hashToken(token: string): number {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash * 33) ^ token.charCodeAt(i)) >>> 0;
  }
  return hash % 1_000_000;
}

async function generateOpenAIEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set - embeddings require an API key');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embedding error: ${response.status}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (process.env.FASTEMBED_URL) return 'fastembed';
  return 'openai';
}

export function getEmbeddingDimension(): number {
  if (getEmbeddingProvider() === 'fastembed') {
    const dim = process.env.FASTEMBED_DIM;
    return dim ? parseInt(dim, 10) : 384; // BAAI/bge-small-en-v1.5 default
  }
  return 1536; // text-embedding-3-small
}

async function generateFastEmbedEmbedding(text: string): Promise<number[]> {
  const baseUrl = process.env.FASTEMBED_URL;
  if (!baseUrl) {
    throw new Error('FASTEMBED_URL not set');
  }

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: [text] }),
  });

  if (!response.ok) {
    throw new Error(`FastEmbed embedding error: ${response.status}`);
  }

  const data = await response.json();
  return data.embeddings[0];
}
