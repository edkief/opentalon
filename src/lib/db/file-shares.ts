import { eq } from 'drizzle-orm';
import { db } from './index';
import { fileShares } from './schema';
import type { FileShare } from './schema';

export async function createFileShare(
  id: string,
  slug: string,
  filePath: string,
  opts?: { mimeHint?: string; agentId?: string; chatId?: string; expiresAt?: Date },
): Promise<void> {
  await db.insert(fileShares).values({
    id,
    slug,
    path: filePath,
    mimeHint: opts?.mimeHint,
    agentId: opts?.agentId,
    chatId: opts?.chatId,
    expiresAt: opts?.expiresAt,
  });
}

export async function getFileShareBySlug(slug: string): Promise<FileShare | null> {
  const rows = await db.select().from(fileShares).where(eq(fileShares.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function listFileShares(): Promise<FileShare[]> {
  return db.select().from(fileShares).orderBy(fileShares.createdAt);
}

export async function deleteFileShare(id: string): Promise<void> {
  await db.delete(fileShares).where(eq(fileShares.id, id));
}

export async function slugExists(slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: fileShares.id })
    .from(fileShares)
    .where(eq(fileShares.slug, slug))
    .limit(1);
  return rows.length > 0;
}
