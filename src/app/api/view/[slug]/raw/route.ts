import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getFileShareBySlug } from '@/lib/db/file-shares';
import { getWorkspaceDir } from '@/lib/tools/built-in';

const MIME_MAP: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const share = await getFileShareBySlug(slug);

  if (!share) return new NextResponse('Not found', { status: 404 });
  if (share.expiresAt && new Date() > share.expiresAt) {
    return new NextResponse('Expired', { status: 410 });
  }

  const workspaceDir = path.resolve(getWorkspaceDir());
  const absPath = path.resolve(
    path.isAbsolute(share.path) ? share.path : path.join(workspaceDir, share.path),
  );

  if (!absPath.startsWith(workspaceDir + path.sep) && absPath !== workspaceDir) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const ext = path.extname(share.path).toLowerCase();
  const contentType = MIME_MAP[ext];
  if (!contentType) {
    return new NextResponse('Not an image', { status: 400 });
  }

  let data: Buffer;
  try {
    data = await fs.readFile(absPath);
  } catch {
    return new NextResponse('File not found', { status: 404 });
  }

  return new NextResponse(data.buffer as ArrayBuffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
