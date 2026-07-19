import { NextRequest, NextResponse } from 'next/server';
import { qdrantClient, COLLECTION_NAME, SCHEMA_MARKER_ID } from '@/lib/memory/client';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const scope = searchParams.get('scope') ?? undefined;
  const category = searchParams.get('category') ?? undefined;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);
  const offset = searchParams.get('offset') ?? undefined;

  // Always exclude the reserved schema-marker point from curation listings.
  const must: unknown[] = [];
  if (scope) must.push({ key: 'scope', match: { value: scope } });
  if (category) must.push({ key: 'category', match: { value: category } });
  const filter = {
    ...(must.length ? { must } : {}),
    must_not: [{ has_id: [SCHEMA_MARKER_ID] }],
  };

  try {
    const result = await qdrantClient.scroll(COLLECTION_NAME, {
      filter,
      limit,
      offset: offset ? parseInt(offset, 10) : undefined,
      with_payload: true,
      with_vector: false,
    });

    return NextResponse.json({
      points: result.points.map((p) => ({ id: p.id, payload: p.payload })),
      nextOffset: result.next_page_offset ?? null,
    });
  } catch (err) {
    console.error('[API/memory] scroll error:', err);
    return NextResponse.json({ error: 'Failed to fetch memories' }, { status: 500 });
  }
}
