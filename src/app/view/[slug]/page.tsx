import { notFound } from 'next/navigation';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getFileShareBySlug } from '@/lib/db/file-shares';
import { getWorkspaceDir } from '@/lib/tools/built-in';
import MarkdownView from './MarkdownView';

interface Props {
  params: Promise<{ slug: string }>;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export default async function ViewPage({ params }: Props) {
  const { slug } = await params;
  const share = await getFileShareBySlug(slug);

  if (!share) return notFound();
  if (share.expiresAt && new Date() > share.expiresAt) {
    return <ErrorView message="This link has expired." />;
  }

  const workspaceDir = path.resolve(getWorkspaceDir());
  const absPath = path.resolve(
    path.isAbsolute(share.path) ? share.path : path.join(workspaceDir, share.path),
  );

  // Path traversal guard
  if (!absPath.startsWith(workspaceDir + path.sep) && absPath !== workspaceDir) {
    return notFound();
  }

  const ext = path.extname(share.path).toLowerCase();
  const filename = path.basename(share.path);

  if (IMAGE_EXTS.has(ext)) {
    return (
      <PageShell title={filename}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/view/${slug}/raw`}
          alt={filename}
          className="max-w-full rounded-lg shadow"
        />
      </PageShell>
    );
  }

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch {
    return <ErrorView message="The file could not be read." />;
  }

  if (ext === '.md') {
    return (
      <PageShell title={filename}>
        <MarkdownView content={content} />
      </PageShell>
    );
  }

  if (ext === '.html' || ext === '.htm') {
    return (
      <PageShell title={filename}>
        <iframe
          srcDoc={content}
          sandbox="allow-scripts allow-same-origin"
          className="w-full border-0 rounded-lg"
          style={{ minHeight: '80vh' }}
          title={filename}
        />
      </PageShell>
    );
  }

  // Fallback: plain text
  return (
    <PageShell title={filename}>
      <pre className="whitespace-pre-wrap break-words text-sm font-mono bg-muted rounded-lg p-4 overflow-auto">
        {content}
      </pre>
    </PageShell>
  );
}

function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p className="text-xs text-muted-foreground mb-4 font-mono">{title}</p>
        {children}
      </div>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <p className="text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
