import { NextRequest, NextResponse } from 'next/server';
import { personaRegistry } from '@/lib/soul';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    personaRegistry.deletePersona(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
}
