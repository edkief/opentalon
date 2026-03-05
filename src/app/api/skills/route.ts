import { NextResponse } from 'next/server';
import { listSkills, createSkill } from '@/lib/skills/skills-manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  const skills = listSkills();
  return NextResponse.json({ skills });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, description, content } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Skill name is required' }, { status: 400 });
    }

    createSkill(
      name,
      description ?? 'A custom skill',
      content ?? '# My Skill\n\nDescribe what this skill does here.',
    );

    return NextResponse.json({ success: true, name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
