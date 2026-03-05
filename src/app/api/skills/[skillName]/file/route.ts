import { NextRequest, NextResponse } from 'next/server';
import { readSkillFile, writeSkillFile } from '@/lib/skills/skills-manager';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ skillName: string }> }
) {
  const { skillName } = await params;
  const { searchParams } = new URL(_request.url);
  const filePath = searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  try {
    const content = readSkillFile(skillName, filePath);
    return NextResponse.json({ content });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read file' },
      { status: 404 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ skillName: string }> }
) {
  const { skillName } = await params;
  const body = await request.json().catch(() => ({})) as { path?: string; content?: string };

  if (!body.path || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'path and content are required' }, { status: 400 });
  }

  try {
    writeSkillFile(skillName, body.path, body.content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to write file' },
      { status: 500 }
    );
  }
}
