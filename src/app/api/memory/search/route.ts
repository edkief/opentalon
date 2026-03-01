import { NextRequest, NextResponse } from 'next/server';
import { qdrantClient, COLLECTION_NAME, ensureInitialized } from '@/lib/memory/client';
import { generateEmbedding, getEmbeddingProvider } from '@/lib/memory/embeddings';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q')?.trim();
  const scope = searchParams.get('scope') ?? undefined;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);

  if (!q) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 });
  }

  try {
    await ensureInitialized();

    const provider = getEmbeddingProvider();
    const vector = await generateEmbedding(q, provider);

    const filter = scope
      ? { must: [{ key: 'scope', match: { value: scope } }] }
      : undefined;

    const results = await qdrantClient.search(COLLECTION_NAME, {
      vector: { name: 'dense', vector },
      filter,
      limit,
      with_payload: true,
    });

    return NextResponse.json(
      results.map((r) => ({ id: r.id, score: r.score, payload: r.payload })),
    );
  } catch (err) {
    console.error('[API/memory/search] error:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
