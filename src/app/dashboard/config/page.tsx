'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
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

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

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

export default function ConfigPage() {
  const apiPath = '/api/config';
  const { isDark } = useTheme();

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [snapStatus, setSnapStatus] = useState<'idle' | 'working'>('idle');
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);

  const editorRef = useRef<unknown>(null);
  const handleSaveRef = useRef<() => void>(() => {});

  const isDirty = content !== savedContent;
  const busy = saveStatus !== 'idle' || snapStatus !== 'idle';

  const debouncedContent = useDebounce(content, 500);

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
    fetch('/api/config/snapshots?file=config')
      .then((r) => r.json())
      .then((s: Snapshot[]) => setSnapshots(s))
      .catch(() => {})
      .finally(() => setLoadingSnaps(false));
  }, []);

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

  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty && saveStatus === 'idle' && !validationError) {
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDirty, saveStatus, validationError, handleSave]);

  const handleSnapshot = async () => {
    setSnapStatus('working');
    await fetch('/api/config/snapshots?file=config', { method: 'POST' });
    loadSnapshots();
    setSnapStatus('idle');
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setSnapStatus('working');
    await fetch('/api/config/snapshots?file=config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: restoreTarget }),
    });
    const d: ApiResponse = await fetch(apiPath).then((r) => r.json());
    setContent(d.content);
    setSavedContent(d.content);
    setValidationError(d.error);
    loadSnapshots();
    setRestoreTarget(null);
    setSnapStatus('idle');
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEditorMount = useCallback(async (editor: any, monaco: any) => {
    editorRef.current = editor;

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => { handleSaveRef.current(); },
    );

    try {
      const { configureMonacoYaml } = await import('monaco-yaml');
      const schema = await fetch('/api/config/schema?file=config').then((r) => r.json());
      configureMonacoYaml(monaco, {
        enableSchemaRequest: false,
        schemas: [{ uri: 'https://openpincer/config-schema.json', fileMatch: ['*'], schema: schema as any }],
      });
    } catch { /* monaco-yaml optional */ }
  }, []);

  const canSave = isDirty && saveStatus === 'idle' && !validationError;

  return (
    <div className="flex flex-col md:flex-row h-full gap-4">
      <div className="flex flex-col flex-1 gap-3 min-w-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Preferences</h1>
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

        {validationError && (
          <div className="rounded-md bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-700 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-400">
            {validationError}
          </div>
        )}

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
              theme={isDark ? 'vs-dark' : 'vs'}
            />
          </div>
        )}
      </div>

      <aside className="hidden md:flex w-56 shrink-0 flex-col gap-2 border-l border-border pl-4">
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
            Restore snapshot &quot;{restoreTarget}&quot;? Current config.yaml will be overwritten.
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
