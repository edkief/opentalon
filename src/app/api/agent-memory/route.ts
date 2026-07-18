import { NextRequest, NextResponse } from 'next/server';
import { memoryManager, CORE_MEMORY_SOFT_LIMIT_TOKENS } from '@/lib/agent/memory-manager';
import { configManager } from '@/lib/config';

export async function GET() {
  const softLimit = configManager.get().memory?.coreSoftLimitTokens ?? CORE_MEMORY_SOFT_LIMIT_TOKENS;
  return NextResponse.json({
    content: memoryManager.getContent(),
    stats: memoryManager.getStats(softLimit),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { content?: string };
    if (typeof body.content !== 'string') {
      return NextResponse.json({ error: 'content must be a string' }, { status: 400 });
    }
    memoryManager.write(body.content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[API/agent-memory] write error:', err);
    return NextResponse.json({ error: 'Failed to save memory' }, { status: 500 });
  }
}
