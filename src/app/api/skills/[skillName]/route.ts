import { NextResponse } from 'next/server';
import { deleteSkill } from '@/lib/skills/skills-manager';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ skillName: string }> }
) {
  const { skillName } = await params;
  try {
    deleteSkill(skillName);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 404 });
  }
}
