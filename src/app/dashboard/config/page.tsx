'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// Monaco must be loaded client-side only
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

type TabKey = 'config' | 'secrets';

interface Snapshot {
  filename: string;
  createdAt: string;
}

interface ApiResponse {
  content: string;
  valid: boolean;
  error: string | null;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function formatSnapshotDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Debounce helper
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function ConfigPage() {
  const [tab, setTab] = useState<TabKey>('config');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [snapStatus, setSnapStatus] = useState<'idle' | 'working'>('idle');
  const editorRef = useRef<unknown>(null);

  const debouncedContent = useDebounce(content, 500);

  // Client-side YAML validation via API (reuses server validate)
  useEffect(() => {
    if (!debouncedContent) { setValidationError(null); return; }
    fetch(`/api/config${tab === 'secrets' ? '/secrets' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: debouncedContent, validate_only: true }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string }) => {
        // If it returned 422 or { ok: false } there's an error
        setValidationError(d.error ?? null);
      })
      .catch(() => setValidationError(null));
  }, [debouncedContent, tab]);

  const apiPath = (t: TabKey) => (t === 'secrets' ? '/api/config/secrets' : '/api/config');

  const loadContent = useCallback((t: TabKey) => {
    setLoading(true);
    fetch(apiPath(t))
      .then((r) => r.json())
      .then((d: ApiResponse) => {
        setContent(d.content);
        setSavedContent(d.content);
        setValidationError(d.error);
      })
      .finally(() => setLoading(false));
  }, []);

  const loadSnapshots = useCallback((t: TabKey) => {
    setLoadingSnaps(true);
    fetch(`/api/config/snapshots?file=${t}`)
      .then((r) => r.json())
      .then((s: Snapshot[]) => setSnapshots(s))
      .catch(() => {})
      .finally(() => setLoadingSnaps(false));
  }, []);

  useEffect(() => {
    loadContent(tab);
    loadSnapshots(tab);
  }, [tab, loadContent, loadSnapshots]);

  // Register JSON Schema with monaco-yaml on editor mount
  const handleEditorMount = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (editor: unknown, monaco: any) => {
      editorRef.current = editor;
      try {
        const { configureMonacoYaml } = await import('monaco-yaml');
        const schema = await fetch(`/api/config/schema?file=${tab}`).then((r) => r.json());
        configureMonacoYaml(monaco, {
          enableSchemaRequest: false,
          schemas: [
            {
              uri: `https://openpincer/${tab}-schema.json`,
              fileMatch: ['*'],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              schema: schema as any,
            },
          ],
        });
      } catch {
        // monaco-yaml optional — editor works without autocompletion
      }
    },
    [tab]
  );

  const handleSave = async () => {
    if (validationError) return;
    setSaveStatus('saving');
    try {
      const res = await fetch(apiPath(tab), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setSavedContent(content);
        setSaveStatus('saved');
      } else {
        const d = await res.json() as { error?: string };
        setValidationError(d.error ?? 'Save failed');
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    }
    setTimeout(() => setSaveStatus('idle'), 2000);
  };

  const handleSnapshot = async () => {
    setSnapStatus('working');
    await fetch(`/api/config/snapshots?file=${tab}`, { method: 'POST' });
    loadSnapshots(tab);
    setSnapStatus('idle');
  };

  const handleRestore = async (filename: string) => {
    if (!confirm(`Restore snapshot "${filename}"? Current ${tab}.yaml will be overwritten.`)) return;
    setSnapStatus('working');
    await fetch(`/api/config/snapshots?file=${tab}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: filename }),
    });
    loadContent(tab);
    loadSnapshots(tab);
    setSnapStatus('idle');
  };

  const isDirty = content !== savedContent;
  const canSave = !validationError && isDirty && saveStatus === 'idle';
  const busy = saveStatus !== 'idle' || snapStatus !== 'idle';

  return (
    <div className="flex h-full gap-4">
      {/* ── Main panel ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 gap-3 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Configuration</h1>
          <div className="flex items-center gap-2">
            {saveStatus === 'saved' && <span className="text-sm text-green-500">Saved</span>}
            {saveStatus === 'error' && <span className="text-sm text-red-500">Failed</span>}
            {isDirty && saveStatus === 'idle' && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleSnapshot}
              disabled={busy || loading}
            >
              Snapshot
            </Button>
            <Button onClick={handleSave} disabled={!canSave || busy}>
              {saveStatus === 'saving' ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border">
          {(['config', 'secrets'] as TabKey[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'config' ? 'Preferences' : 'Secrets'}
            </button>
          ))}
        </div>

        {/* Secrets warning banner */}
        {tab === 'secrets' && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            <strong>Warning:</strong> This file contains credentials. Do not commit{' '}
            <code>secrets.yaml</code> to version control.
          </div>
        )}

        {/* Validation error */}
        {validationError && (
          <div className="rounded-md bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-700 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-400">
            {validationError}
          </div>
        )}

        {/* Editor */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Loading…
          </div>
        ) : (
          <div className="flex-1 border border-border rounded-md overflow-hidden">
            <MonacoEditor
              language="yaml"
              value={content}
              onChange={(v) => setContent(v ?? '')}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
              }}
              theme="vs-dark"
            />
          </div>
        )}
      </div>

      {/* ── Snapshots sidebar ────────────────────────────────────────────────── */}
      <aside className="w-56 shrink-0 flex flex-col gap-2 border-l border-border pl-4">
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-sm font-medium">Snapshots</span>
          <Badge variant="outline" className="text-[10px]">
            {snapshots.length}
          </Badge>
        </div>

        <div className="flex-1 overflow-auto flex flex-col gap-1.5">
          {loadingSnaps && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!loadingSnaps && snapshots.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No snapshots yet. Click &quot;Snapshot&quot; to save one.
            </p>
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
  );
}
