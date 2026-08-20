import { NextRequest, NextResponse } from 'next/server';
import { qdrantClient, COLLECTION_NAME, ensureInitialized } from '@/lib/memory/client';
import { generateEmbedding, getEmbeddingProvider } from '@/lib/memory/embeddings';
import { agentRegistry } from '@/lib/soul';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q')?.trim();
  const scope = searchParams.get('scope') ?? undefined;
  const category = searchParams.get('category') ?? undefined;
  const agent = searchParams.get('agent') ?? undefined;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
  const offsetParam = searchParams.get('offset');
  const offset = offsetParam ? Math.max(parseInt(offsetParam, 10), 0) : undefined;

  if (!q) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 });
  }

  try {
    await ensureInitialized();

    const provider = getEmbeddingProvider();
    const vector = await generateEmbedding(q, provider);

    const must: unknown[] = [];
    if (scope) must.push({ key: 'scope', match: { value: scope } });
    if (category) must.push({ key: 'category', match: { value: category } });
    // Default-agent notes carry no `agent` tag, so filtering the default agent
    // means "the agent field is empty".
    if (agent) {
      must.push(
        agentRegistry.isDefaultAgent(agent)
          ? { is_empty: { key: 'agent' } }
          : { key: 'agent', match: { value: agent } },
      );
    }
    const filter = must.length ? { must } : undefined;

    const response = await qdrantClient.query(COLLECTION_NAME, {
      query: vector,
      using: 'dense',
      filter,
      limit,
      offset,
      with_payload: true,
    });

    return NextResponse.json(
      response.points.map((r) => ({ id: r.id, score: r.score, payload: r.payload })),
    );
  } catch (err) {
    console.error('[API/memory/search] error:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
