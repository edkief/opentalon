import { NextRequest, NextResponse } from 'next/server';
import { configJsonSchema, secretsJsonSchema } from '@/lib/config/schema';

export async function GET(req: NextRequest) {
  const file = req.nextUrl.searchParams.get('file') ?? 'config';
  const schema = file === 'secrets' ? secretsJsonSchema : configJsonSchema;
  return NextResponse.json(schema);
}
