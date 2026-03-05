import { NextResponse } from 'next/server';
import { listSkillFiles } from '@/lib/skills/skills-manager';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ skillName: string }> }
) {
  const { skillName } = await params;
  const files = listSkillFiles(skillName);
  return NextResponse.json({ files });
}
