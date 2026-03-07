'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useTheme } from '@/hooks/use-theme';

// MDEditor uses browser APIs — must be loaded client-side only
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

type Status = 'idle' | 'saving' | 'saved' | 'error' | 'snapshoting' | 'restoring';

interface Snapshot {
  filename: string;
  createdAt: string;
}

function formatSnapshotDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function SoulPage() {
  const { isDark } = useTheme();
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);

  const loadSoul = () => {
    setLoading(true);
    fetch('/api/soul')
      .then((r) => r.json())
      .then((d: { content: string }) => setContent(d.content))
      .finally(() => setLoading(false));
  };

  const loadSnapshots = () => {
    setLoadingSnaps(true);
    fetch('/api/soul/snapshots')
      .then((r) => r.json())
      .then((s: Snapshot[]) => setSnapshots(s))
      .catch(() => {})
      .finally(() => setLoadingSnaps(false));
  };

  useEffect(() => {
    queueMicrotask(() => {
      loadSoul();
      loadSnapshots();
    })
  }, []);

  const handleSave = async () => {
    setStatus('saving');
    try {
      const res = await fetch('/api/soul', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setStatus(res.ok ? 'saved' : 'error');
    } catch {
      setStatus('error');
    }
    setTimeout(() => setStatus('idle'), 2000);
  };

  const handleSnapshot = async () => {
    setStatus('snapshoting');
    await fetch('/api/soul/snapshots', { method: 'POST' });
    loadSnapshots();
    setStatus('idle');
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setStatus('restoring');
    await fetch('/api/soul/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: restoreTarget }),
    });
    loadSoul();
    setRestoreTarget(null);
    setStatus('idle');
  };

  const busy = status !== 'idle';

  return (
    <div className="flex flex-col md:flex-row h-full gap-4">
      {/* ── Editor ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 gap-4 min-w-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Soul Editor</h1>
          <div className="flex items-center gap-2">
            {status === 'saved' && <span className="text-sm text-green-500">Saved</span>}
            {status === 'error' && <span className="text-sm text-red-500">Failed</span>}
            <Button variant="outline" size="sm" onClick={handleSnapshot} disabled={busy || loading}>
              Snapshot
            </Button>
            <Button onClick={handleSave} disabled={busy || loading}>
              {status === 'saving' ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Loading soul…
          </div>
        ) : (
          <div className="flex-1 overflow-auto" data-color-mode={isDark ? 'dark' : 'light'}>
            <MDEditor
              value={content}
              onChange={(v) => setContent(v ?? '')}
              height="100%"
              preview="edit"
            />
          </div>
        )}
      </div>

      {/* ── Snapshots sidebar ───────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col gap-2 border-l border-border pl-4">
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-sm font-medium">Snapshots</span>
          <Badge variant="outline" className="text-[10px]">{snapshots.length}</Badge>
        </div>

        <div className="flex-1 overflow-auto flex flex-col gap-1.5">
          {loadingSnaps && (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
          {!loadingSnaps && snapshots.length === 0 && (
            <p className="text-xs text-muted-foreground">No snapshots yet. Click "Snapshot" to save one.</p>
          )}
          {snapshots.map((snap) => (
            <div
              key={snap.filename}
              className="rounded border border-border p-2 text-xs flex flex-col gap-1 bg-muted/40"
            >
              <span className="text-muted-foreground font-mono truncate text-[10px]">
                {formatSnapshotDate(snap.createdAt)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px] w-full"
                disabled={busy}
                onClick={() => setRestoreTarget(snap.filename)}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      </aside>

      <Dialog open={restoreTarget !== null} onOpenChange={(o) => !o && setRestoreTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Restore snapshot?</DialogTitle>
            <DialogDescription>
            Restore snapshot &quot;{restoreTarget}&quot;? Current soul will be overwritten.
          </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleRestore}>Restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
