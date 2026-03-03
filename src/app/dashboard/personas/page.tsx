'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface PersonaMeta {
  id: string;
  soulPreview: string;
}

interface Snapshot {
  filename: string;
  createdAt: string;
}

type EditorTab = 'soul' | 'identity';
type Status = 'idle' | 'saving' | 'saved' | 'error' | 'snapshoting' | 'restoring' | 'creating' | 'deleting';

function formatSnapshotDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function PersonasPage() {
  const [personas, setPersonas] = useState<PersonaMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('soul');
  const [soulContent, setSoulContent] = useState('');
  const [identityContent, setIdentityContent] = useState('');
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [loadingContent, setLoadingContent] = useState(false);
  const [newPersonaName, setNewPersonaName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);

  const loadPersonas = useCallback(() => {
    fetch('/api/personas')
      .then((r) => r.json())
      .then((data: PersonaMeta[]) => setPersonas(data))
      .catch(() => {});
  }, []);

  useEffect(() => { loadPersonas(); }, [loadPersonas]);

  const selectPersona = useCallback((id: string) => {
    setSelectedId(id);
    setTab('soul');
    setLoadingContent(true);
    setSnapshots([]);
    Promise.all([
      fetch(`/api/personas/${id}/soul`).then((r) => r.json()),
      fetch(`/api/personas/${id}/identity`).then((r) => r.json()),
      fetch(`/api/personas/${id}/snapshots`).then((r) => r.json()),
    ])
      .then(([s, i, snaps]: [{ content: string }, { content: string }, Snapshot[]]) => {
        setSoulContent(s.content ?? '');
        setIdentityContent(i.content ?? '');
        setSnapshots(snaps ?? []);
      })
      .catch(() => {})
      .finally(() => setLoadingContent(false));
  }, []);

  const handleSave = async () => {
    if (!selectedId) return;
    setStatus('saving');
    try {
      const endpoint = tab === 'soul'
        ? `/api/personas/${selectedId}/soul`
        : `/api/personas/${selectedId}/identity`;
      const content = tab === 'soul' ? soulContent : identityContent;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setStatus(res.ok ? 'saved' : 'error');
      if (res.ok) loadPersonas();
    } catch {
      setStatus('error');
    }
    setTimeout(() => setStatus('idle'), 2000);
  };

  const handleSnapshot = async () => {
    if (!selectedId) return;
    setStatus('snapshoting');
    await fetch(`/api/personas/${selectedId}/snapshots`, { method: 'POST' });
    const snaps: Snapshot[] = await fetch(`/api/personas/${selectedId}/snapshots`).then((r) => r.json());
    setSnapshots(snaps);
    setStatus('idle');
  };

  const handleRestore = async (filename: string) => {
    if (!selectedId) return;
    if (!confirm(`Restore snapshot "${filename}"? Current soul will be overwritten.`)) return;
    setStatus('restoring');
    await fetch(`/api/personas/${selectedId}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: filename }),
    });
    selectPersona(selectedId);
    setStatus('idle');
  };

  const handleCreate = async () => {
    const name = newPersonaName.trim();
    if (!name) return;
    setStatus('creating');
    try {
      const res = await fetch('/api/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: name }),
      });
      if (res.ok) {
        loadPersonas();
        setNewPersonaName('');
        setShowNewForm(false);
        selectPersona(name);
      } else {
        const d = await res.json() as { error?: string };
        alert(d.error ?? 'Failed to create persona');
      }
    } catch {
      alert('Failed to create persona');
    }
    setStatus('idle');
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete persona "${id}"? This cannot be undone.`)) return;
    setStatus('deleting');
    await fetch(`/api/personas/${id}`, { method: 'DELETE' });
    if (selectedId === id) setSelectedId(null);
    loadPersonas();
    setStatus('idle');
  };

  const busy = status !== 'idle';
  const currentContent = tab === 'soul' ? soulContent : identityContent;
  const setCurrentContent = tab === 'soul' ? setSoulContent : setIdentityContent;

  return (
    <div className="flex h-full gap-0 overflow-hidden">
      {/* ── Persona list (left panel) ──────────────────────────────────────── */}
      <div className="w-48 shrink-0 flex flex-col border-r border-border pr-3 mr-4 gap-2 overflow-y-auto">
        <div className="flex items-center justify-between py-1">
          <span className="text-sm font-semibold">Personas</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setShowNewForm((v) => !v)}
          >
            {showNewForm ? 'Cancel' : '+ New'}
          </Button>
        </div>

        {showNewForm && (
          <div className="flex flex-col gap-1.5">
            <input
              className="text-xs border border-border rounded px-2 py-1 bg-background w-full focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="name (a-z, 0-9, -_)"
              value={newPersonaName}
              onChange={(e) => setNewPersonaName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              autoFocus
            />
            <Button size="sm" className="h-6 text-xs w-full" disabled={busy || !newPersonaName.trim()} onClick={handleCreate}>
              Create
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-0.5">
          {personas.map((p) => (
            <div
              key={p.id}
              className={[
                'group flex items-center justify-between rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
                selectedId === p.id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              ].join(' ')}
              onClick={() => selectPersona(p.id)}
            >
              <span className="truncate font-mono text-xs">{p.id}</span>
              {p.id !== 'default' && (
                <button
                  className="opacity-0 group-hover:opacity-100 ml-1 shrink-0 text-destructive hover:text-destructive/80 text-[10px] transition-opacity"
                  onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                  title="Delete persona"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {personas.length === 0 && (
            <p className="text-xs text-muted-foreground px-2">No personas yet.</p>
          )}
        </div>
      </div>

      {/* ── Editor (right panel) ───────────────────────────────────────────── */}
      {selectedId ? (
        <div className="flex flex-col flex-1 gap-3 min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold font-mono">{selectedId}</span>
              <div className="flex gap-1">
                {(['soul', 'identity'] as EditorTab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={[
                      'text-xs px-2 py-0.5 rounded border transition-colors capitalize',
                      tab === t
                        ? 'bg-accent text-accent-foreground border-accent'
                        : 'border-border text-muted-foreground hover:bg-accent/60',
                    ].join(' ')}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {status === 'saved' && <span className="text-xs text-green-500">Saved</span>}
              {status === 'error' && <span className="text-xs text-red-500">Failed</span>}
              <Button variant="outline" size="sm" onClick={handleSnapshot} disabled={busy || loadingContent}>
                Snapshot
              </Button>
              <Button size="sm" onClick={handleSave} disabled={busy || loadingContent}>
                {status === 'saving' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>

          {/* Editor */}
          {loadingContent ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Loading…
            </div>
          ) : (
            <div className="flex flex-1 gap-4 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-auto" data-color-mode="auto">
                <MDEditor
                  value={currentContent}
                  onChange={(v) => setCurrentContent(v ?? '')}
                  height="100%"
                  preview="edit"
                />
              </div>

              {/* Snapshots sidebar */}
              <aside className="w-48 shrink-0 flex flex-col gap-2 border-l border-border pl-3 overflow-y-auto">
                <div className="flex items-center justify-between pt-0.5">
                  <span className="text-xs font-medium">Snapshots</span>
                  <Badge variant="outline" className="text-[10px]">{snapshots.length}</Badge>
                </div>
                <div className="flex flex-col gap-1.5">
                  {snapshots.length === 0 && (
                    <p className="text-xs text-muted-foreground">No snapshots yet.</p>
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
                        onClick={() => handleRestore(snap.filename)}
                      >
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              </aside>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Select a persona to edit, or create a new one.
        </div>
      )}
    </div>
  );
}
