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

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Per-tab editor ────────────────────────────────────────────────────────────

interface YamlEditorProps {
  tabKey: TabKey;
  visible: boolean;
  onStatusChange: (status: { saveStatus: SaveStatus; isDirty: boolean; validationError: string | null; snapshots: Snapshot[]; loadingSnaps: boolean; loading: boolean }) => void;
  saveRef: React.MutableRefObject<() => void>;
  snapshotRef: React.MutableRefObject<() => void>;
  restoreRef: React.MutableRefObject<(filename: string) => void>;
}

function YamlEditor({ tabKey, visible, onStatusChange, saveRef, snapshotRef, restoreRef }: YamlEditorProps) {
  const apiPath = tabKey === 'secrets' ? '/api/config/secrets' : '/api/config';

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [snapStatus, setSnapStatus] = useState<'idle' | 'working'>('idle');

  const editorRef = useRef<unknown>(null);
  const handleSaveRef = useRef<() => void>(() => {});

  const isDirty = content !== savedContent;
  const busy = saveStatus !== 'idle' || snapStatus !== 'idle';

  // Propagate status to parent so it can render the toolbar correctly
  useEffect(() => {
    onStatusChange({ saveStatus, isDirty, validationError, snapshots, loadingSnaps, loading });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveStatus, isDirty, validationError, snapshots, loadingSnaps, loading]);

  const debouncedContent = useDebounce(content, 500);

  // Live validation (validate-only POST)
  useEffect(() => {
    if (!debouncedContent) { setValidationError(null); return; }
    fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: debouncedContent, validate_only: true }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string }) => setValidationError(d.error ?? null))
      .catch(() => setValidationError(null));
  }, [debouncedContent, apiPath]);

  const loadSnapshots = useCallback(() => {
    setLoadingSnaps(true);
    fetch(`/api/config/snapshots?file=${tabKey}`)
      .then((r) => r.json())
      .then((s: Snapshot[]) => setSnapshots(s))
      .catch(() => {})
      .finally(() => setLoadingSnaps(false));
  }, [tabKey]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    setValidationError(null);
    fetch(apiPath)
      .then((r) => r.json())
      .then((d: ApiResponse) => {
        setContent(d.content);
        setSavedContent(d.content);
        setValidationError(d.error);
      })
      .finally(() => setLoading(false));
    loadSnapshots();
  }, [apiPath, loadSnapshots]);

  const handleSave = useCallback(async () => {
    if (validationError || !content) return;
    setSaveStatus('saving');
    try {
      const res = await fetch(apiPath, {
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
  }, [content, validationError, apiPath]);

  // Keep stable ref for Ctrl+S closure
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  // Expose actions to parent via refs
  useEffect(() => { saveRef.current = handleSave; }, [handleSave, saveRef]);

  useEffect(() => {
    snapshotRef.current = async () => {
      setSnapStatus('working');
      await fetch(`/api/config/snapshots?file=${tabKey}`, { method: 'POST' });
      loadSnapshots();
      setSnapStatus('idle');
    };
  }, [tabKey, loadSnapshots, snapshotRef]);

  useEffect(() => {
    restoreRef.current = async (filename: string) => {
      if (!confirm(`Restore snapshot "${filename}"? Current ${tabKey}.yaml will be overwritten.`)) return;
      setSnapStatus('working');
      await fetch(`/api/config/snapshots?file=${tabKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore: filename }),
      });
      // Reload content from server
      const d: ApiResponse = await fetch(apiPath).then((r) => r.json());
      setContent(d.content);
      setSavedContent(d.content);
      setValidationError(d.error);
      loadSnapshots();
      setSnapStatus('idle');
    };
  }, [tabKey, apiPath, loadSnapshots, restoreRef]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEditorMount = useCallback(async (editor: any, monaco: any) => {
    editorRef.current = editor;

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => { handleSaveRef.current(); },
    );

    try {
      const { configureMonacoYaml } = await import('monaco-yaml');
      const schema = await fetch(`/api/config/schema?file=${tabKey}`).then((r) => r.json());
      configureMonacoYaml(monaco, {
        enableSchemaRequest: false,
        schemas: [{ uri: `https://openpincer/${tabKey}-schema.json`, fileMatch: ['*'], schema: schema as any }],
      });
    } catch { /* monaco-yaml optional */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // called once on mount — tabKey and apiPath are stable per instance

  return (
    <div className={`flex-1 flex flex-col gap-3 min-w-0 ${visible ? 'flex' : 'hidden'}`}>
      {/* Secrets warning */}
      {tabKey === 'secrets' && (
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
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConfigPage() {
  const [tab, setTab] = useState<TabKey>('config');

  // Per-tab status bubbled up from each YamlEditor
  const [statuses, setStatuses] = useState<Record<TabKey, {
    saveStatus: SaveStatus;
    isDirty: boolean;
    validationError: string | null;
    snapshots: Snapshot[];
    loadingSnaps: boolean;
    loading: boolean;
  }>>({
    config: { saveStatus: 'idle', isDirty: false, validationError: null, snapshots: [], loadingSnaps: false, loading: true },
    secrets: { saveStatus: 'idle', isDirty: false, validationError: null, snapshots: [], loadingSnaps: false, loading: true },
  });

  const configSaveRef = useRef<() => void>(() => {});
  const configSnapshotRef = useRef<() => void>(() => {});
  const configRestoreRef = useRef<(f: string) => void>(() => {});

  const secretsSaveRef = useRef<() => void>(() => {});
  const secretsSnapshotRef = useRef<() => void>(() => {});
  const secretsRestoreRef = useRef<(f: string) => void>(() => {});

  const activeStatus = statuses[tab];
  const { saveStatus, isDirty, validationError, snapshots, loadingSnaps, loading } = activeStatus;

  const canSave = isDirty && saveStatus === 'idle' && !validationError;
  const busy = saveStatus !== 'idle';

  const handleSave = () => (tab === 'config' ? configSaveRef : secretsSaveRef).current();
  const handleSnapshot = () => (tab === 'config' ? configSnapshotRef : secretsSnapshotRef).current();
  const handleRestore = (f: string) => (tab === 'config' ? configRestoreRef : secretsRestoreRef).current(f);

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

        {/* Both editors always mounted; CSS show/hide avoids remount and stale content */}
        <YamlEditor
          tabKey="config"
          visible={tab === 'config'}
          onStatusChange={(s) => setStatuses(prev => ({ ...prev, config: s }))}
          saveRef={configSaveRef}
          snapshotRef={configSnapshotRef}
          restoreRef={configRestoreRef}
        />
        <YamlEditor
          tabKey="secrets"
          visible={tab === 'secrets'}
          onStatusChange={(s) => setStatuses(prev => ({ ...prev, secrets: s }))}
          saveRef={secretsSaveRef}
          snapshotRef={secretsSnapshotRef}
          restoreRef={secretsRestoreRef}
        />
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
