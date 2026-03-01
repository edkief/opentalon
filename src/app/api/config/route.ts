import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { configManager } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const content = fs.existsSync(configManager.configPath)
    ? fs.readFileSync(configManager.configPath, 'utf-8')
    : '';

  const validation = configManager.validate(content, 'config');
  return NextResponse.json({
    content,
    valid: validation.ok,
    error: validation.error ?? null,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { content?: string };
  if (typeof body.content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }

  const validation = configManager.validate(body.content, 'config');
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 422 });
  }

  configManager.write(body.content, 'config');
  return NextResponse.json({ ok: true });
}
