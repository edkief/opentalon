'use client';

import { useEffect, useState, useCallback } from 'react';
import { Share2, Trash2, RefreshCw, ExternalLink, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface FileShare {
  id: string;
  slug: string;
  path: string;
  mimeHint: string | null;
  agentId: string | null;
  chatId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function isExpired(share: FileShare) {
  return !!share.expiresAt && new Date() > new Date(share.expiresAt);
}

export default function SharedFilesPage() {
  const [shares, setShares] = useState<FileShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/shared-files');
      if (res.ok) setShares(await res.json() as FileShare[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch('/api/shared-files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setShares((prev) => prev.filter((s) => s.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Share2 className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Shared Files</h1>
            <p className="text-sm text-muted-foreground">
              Files shared by agents via <code className="font-mono text-xs">create_view_link</code>
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {!loading && shares.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-2 text-muted-foreground">
          <Share2 className="h-10 w-10 opacity-30" />
          <p className="text-sm">No shared files yet.</p>
          <p className="text-xs">Agents can share workspace files using the <code className="font-mono">create_view_link</code> tool.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shares.map((share) => {
                const expired = isExpired(share);
                return (
                  <TableRow key={share.id} className={expired ? 'opacity-50' : ''}>
                    <TableCell className="font-mono text-xs">
                      <div className="flex items-center gap-1.5">
                        {share.slug}
                        {expired && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock className="h-3 w-3" /> expired
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-xs truncate">
                      {share.path}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground capitalize">
                      {share.mimeHint ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(share.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(share.expiresAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {!expired && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            asChild
                          >
                            <a href={`/view/${share.slug}`} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(share.id)}
                          disabled={deletingId === share.id}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
