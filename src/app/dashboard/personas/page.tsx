'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState, useCallback } from 'react';
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

interface ConfirmState {
  type: 'restore' | 'delete' | null;
  target: string | null;
}

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

interface PersonaMeta {
  id: string;
  soulPreview: string;
}

interface Snapshot {
  filename: string;
  createdAt: string;
}

interface ModelConfig {
  model: string;
  fallbacks: string[];
}

interface AvailableModels {
  models: string[];
}

interface ToolEntry {
  name: string;
  category: string;
}

interface ConfigStatus {
  memoryEnabled?: boolean;
}

type EditorTab = 'soul' | 'identity' | 'models' | 'tools' | 'rag';
type Status = 'idle' | 'saving' | 'saved' | 'error' | 'snapshoting' | 'restoring' | 'creating' | 'deleting';

function formatSnapshotDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function PersonasPage() {
  const { isDark } = useTheme();
  const [personas, setPersonas] = useState<PersonaMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('soul');
  const [soulContent, setSoulContent] = useState('');
  const [identityContent, setIdentityContent] = useState('');
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ model: '', fallbacks: [] });
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [loadingContent, setLoadingContent] = useState(false);
  const [newPersonaName, setNewPersonaName] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>({ type: null, target: null });

  // Available models from config/secrets
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Tools tab state
  const [allTools, setAllTools] = useState<ToolEntry[]>([]);
  const [enabledTools, setEnabledTools] = useState<string[] | null>(null); // null = all allowed

  // RAG tab state
  const [ragEnabled, setRagEnabled] = useState(true);
  const [memoryEnabled, setMemoryEnabled] = useState<boolean | null>(null);

  const loadPersonas = useCallback(() => {
    fetch('/api/personas')
      .then((r) => r.json())
      .then((data: PersonaMeta[]) => setPersonas(data))
      .catch(() => {});
  }, []);

  useEffect(() => { loadPersonas(); }, [loadPersonas]);

  // Load available models and tools once on mount
  useEffect(() => {
    fetch('/api/config/models')
      .then((r) => r.json())
      .then((d: AvailableModels) => setAvailableModels(d.models))
      .catch(() => {});
    fetch('/api/tools')
      .then((r) => r.json())
      .then((d: { tools: ToolEntry[] }) => setAllTools(d.tools))
      .catch(() => {});

    fetch('/api/config/status')
      .then((r) => r.json())
      .then((d: ConfigStatus) => {
        if (typeof d.memoryEnabled === 'boolean') {
          setMemoryEnabled(d.memoryEnabled);
        }
      })
      .catch(() => {});
  }, []);

  const selectPersona = useCallback((id: string) => {
    setSelectedId(id);
    setTab('soul');
    setLoadingContent(true);
    setSnapshots([]);
    Promise.all([
      fetch(`/api/personas/${id}/soul`).then((r) => r.json()),
      fetch(`/api/personas/${id}/identity`).then((r) => r.json()),
      fetch(`/api/personas/${id}/snapshots`).then((r) => r.json()),
      fetch(`/api/personas/${id}/model`).then((r) => r.json()),
      fetch(`/api/personas/${id}/tools`).then((r) => r.json()),
      fetch(`/api/personas/${id}/rag`).then((r) => r.json()),
    ])
      .then(([s, i, snaps, mc, tc, rc]: [
        { content: string },
        { content: string },
        Snapshot[],
        ModelConfig,
        { tools: string[] | null },
        { ragEnabled: boolean },
      ]) => {
        setSoulContent(s.content ?? '');
        setIdentityContent(i.content ?? '');
        setSnapshots(snaps ?? []);
        setModelConfig({ model: mc.model ?? '', fallbacks: mc.fallbacks ?? [] });
        setEnabledTools(tc.tools ?? null);
        setRagEnabled(rc.ragEnabled ?? true);
      })
      .catch(() => {})
      .finally(() => setLoadingContent(false));
  }, []);

  const handleSave = async () => {
    if (!selectedId) return;
    setStatus('saving');
    try {
      if (tab === 'models') {
        const res = await fetch(`/api/personas/${selectedId}/model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelConfig.model.trim() || null,
            fallbacks: modelConfig.fallbacks.filter(Boolean),
          }),
        });
        setStatus(res.ok ? 'saved' : 'error');
      } else if (tab === 'tools') {
        const res = await fetch(`/api/personas/${selectedId}/tools`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tools: enabledTools }),
        });
        setStatus(res.ok ? 'saved' : 'error');
      } else if (tab === 'rag') {
        const res = await fetch(`/api/personas/${selectedId}/rag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ragEnabled }),
        });
        setStatus(res.ok ? 'saved' : 'error');
      } else {
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
      }
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

  const handleRestore = async () => {
    if (!selectedId || !confirmState.target) return;
    setStatus('restoring');
    await fetch(`/api/personas/${selectedId}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: confirmState.target }),
    });
    selectPersona(selectedId);
    setConfirmState({ type: null, target: null });
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

  const handleDelete = async () => {
    if (!confirmState.target) return;
    setStatus('deleting');
    await fetch(`/api/personas/${confirmState.target}`, { method: 'DELETE' });
    if (selectedId === confirmState.target) setSelectedId(null);
    loadPersonas();
    setConfirmState({ type: null, target: null });
    setStatus('idle');
  };

  const toggleTool = (name: string) => {
    if (enabledTools === null) {
      // Currently unrestricted — switching to explicit list excluding this tool
      setEnabledTools(allTools.map((t) => t.name).filter((n) => n !== name));
    } else if (enabledTools.includes(name)) {
      const next = enabledTools.filter((n) => n !== name);
      setEnabledTools(next);
    } else {
      const next = [...enabledTools, name];
      // If all tools are now enabled, revert to null (unrestricted)
      setEnabledTools(next.length === allTools.length ? null : next);
    }
  };

  const isToolEnabled = (name: string) =>
    enabledTools === null || enabledTools.includes(name);

  const toggleCategory = (category: string) => {
    const categoryToolNames = allTools.filter((t) => t.category === category).map((t) => t.name);
    const allEnabled = categoryToolNames.every((n) => isToolEnabled(n));

    if (enabledTools === null) {
      if (allEnabled) {
        setEnabledTools(allTools.map((t) => t.name).filter((n) => !categoryToolNames.includes(n)));
      } else {
        setEnabledTools(allTools.map((t) => t.name));
      }
    } else {
      if (allEnabled) {
        setEnabledTools(enabledTools.filter((n) => !categoryToolNames.includes(n)));
      } else {
        const next = [...new Set([...enabledTools, ...categoryToolNames])];
        setEnabledTools(next.length === allTools.length ? null : next);
      }
    }
  };

  const isCategoryEnabled = (category: string) => {
    const categoryToolNames = allTools.filter((t) => t.category === category).map((t) => t.name);
    return categoryToolNames.every((n) => isToolEnabled(n));
  };

  const busy = status !== 'idle';
  const currentContent = tab === 'soul' ? soulContent : identityContent;
  const setCurrentContent = tab === 'soul' ? setSoulContent : setIdentityContent;

  // Group tools by category for display
  const toolsByCategory = allTools.reduce<Record<string, ToolEntry[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="flex flex-col md:flex-row h-full gap-0 overflow-hidden">
      {/* ── Persona list (left panel) ──────────────────────────────────────── */}
      <div className="w-full md:w-48 shrink-0 flex flex-col border-b md:border-b-0 md:border-r border-border pr-3 mr-0 md:mr-4 gap-2 overflow-y-auto max-h-40 md:max-h-none">
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
          {(() => {
            const defaultPersona = personas.find((p) => p.id === 'default');
            const otherPersonas = personas
              .filter((p) => p.id !== 'default')
              .sort((a, b) => a.id.localeCompare(b.id));
            const sortedPersonas = defaultPersona ? [defaultPersona, ...otherPersonas] : otherPersonas;
            const showSeparator = defaultPersona && otherPersonas.length > 0;
            return (
              <>
                {sortedPersonas.map((p, idx) => (
                  <div key={idx}>
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
                          className="opacity-60 group-hover:opacity-100 ml-1 shrink-0 text-destructive hover:text-destructive/80 text-[10px] transition-opacity"
                          onClick={(e) => { e.stopPropagation(); setConfirmState({ type: 'delete', target: p.id }); }}
                          title="Delete persona"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {showSeparator && idx == 0 && (
                      <div className="border-t border-border my-1" />
                    )}
                  </div>
                ))}
              </>
            );
          })()}
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
                {(['soul', 'identity', 'models', 'tools', 'rag'] as EditorTab[]).map((t) => (
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
              {tab !== 'models' && tab !== 'tools' && tab !== 'rag' && (
                <Button variant="outline" size="sm" onClick={handleSnapshot} disabled={busy || loadingContent}>
                  Snapshot
                </Button>
              )}
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
          ) : tab === 'models' ? (
            /* ── Models tab ── */
            <div className="flex flex-col gap-5 p-1 flex-1 overflow-y-auto max-w-lg">
              <p className="text-xs text-muted-foreground">
                Models are drawn from your configured providers and API keys.
                Leave blank to inherit from <code className="font-mono bg-muted px-1 rounded">config.yaml</code>.
                {availableModels.length === 0 && (
                  <span className="text-amber-500"> No models detected — check your API keys in secrets.yaml.</span>
                )}
              </p>

              {/* Primary model */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium">Primary Model</label>
                <select
                  className="text-xs border border-border rounded px-2 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  value={modelConfig.model}
                  onChange={(e) => setModelConfig(c => ({ ...c, model: e.target.value }))}
                >
                  <option value="">— inherit from config.yaml —</option>
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              {/* Fallbacks */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">Fallbacks</label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setModelConfig(c => ({ ...c, fallbacks: [...c.fallbacks, ''] }))}
                    disabled={availableModels.length === 0}
                  >
                    + Add
                  </Button>
                </div>
                {modelConfig.fallbacks.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No fallbacks configured — will use <code className="font-mono bg-muted px-1 rounded">config.yaml</code> fallbacks if set.
                  </p>
                )}
                {modelConfig.fallbacks.map((fb, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <select
                      className="flex-1 text-xs border border-border rounded px-2 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                      value={fb}
                      onChange={(e) => setModelConfig(c => {
                        const arr = [...c.fallbacks];
                        arr[i] = e.target.value;
                        return { ...c, fallbacks: arr };
                      })}
                    >
                      <option value="">— select model —</option>
                      {availableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                    <button
                      className="text-destructive text-xs hover:text-destructive/80 shrink-0 px-1"
                      onClick={() => setModelConfig(c => ({
                        ...c,
                        fallbacks: c.fallbacks.filter((_, j) => j !== i),
                      }))}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : tab === 'tools' ? (
            /* ── Tools tab ── */
            <div className="flex flex-col gap-4 p-1 flex-1 overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {enabledTools === null
                    ? 'All tools enabled. Uncheck any tool to restrict access.'
                    : `${enabledTools.length} of ${allTools.length} tools enabled.`}
                </p>
                <div className="flex gap-2">
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                    onClick={() => setEnabledTools(null)}
                  >
                    Enable all
                  </button>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                    onClick={() => setEnabledTools([])}
                  >
                    Disable all
                  </button>
                </div>
              </div>

              {allTools.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tools available.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {Object.entries(toolsByCategory).map(([category, tools]) => (
                    <div key={category} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => toggleCategory(category)}
                          className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {category} {isCategoryEnabled(category) ? '✓' : '✗'}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {tools.map((t) => {
                          const on = isToolEnabled(t.name);
                          return (
                            <button
                              key={t.name}
                              onClick={() => toggleTool(t.name)}
                              className={[
                                'text-xs font-mono px-2 py-0.5 rounded border transition-colors',
                                on
                                  ? 'bg-accent text-accent-foreground border-accent'
                                  : 'border-border text-muted-foreground hover:bg-accent/40',
                              ].join(' ')}
                            >
                              {t.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === 'rag' ? (
            /* ── RAG tab ── */
            <div className="flex flex-col gap-4 p-1 flex-1 overflow-y-auto max-w-lg">
              <p className="text-xs text-muted-foreground">
                Control whether this persona automatically retrieves relevant memories from the
                vector database and injects them into the conversation context.
              </p>

              {memoryEnabled === false && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Global memory is disabled in <code className="font-mono bg-amber-100 px-1 rounded">config.yaml</code>{' '}
                  (<code className="font-mono bg-amber-100 px-1 rounded">memory.enabled: false</code>), so this RAG
                  setting has no effect until memory is enabled.
                </p>
              )}

              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">RAG Injection</span>
                  <span className="text-xs text-muted-foreground">
                    {ragEnabled
                      ? 'Relevant memories are automatically retrieved and injected into context.'
                      : 'No automatic memory retrieval. Persona relies only on Soul and Identity.'}
                  </span>
                </div>
                <button
                  onClick={() => setRagEnabled(!ragEnabled)}
                  className={[
                    'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    ragEnabled ? 'bg-green-600' : 'bg-muted',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform',
                      ragEnabled ? 'translate-x-5' : 'translate-x-0',
                    ].join(' ')}
                  />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 gap-4 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-auto" data-color-mode={isDark ? 'dark' : 'light'}>
                <MDEditor
                  value={currentContent}
                  onChange={(v) => setCurrentContent(v ?? '')}
                  height="100%"
                  preview="edit"
                />
              </div>

              {/* Snapshots sidebar */}
              <aside className="hidden md:flex w-48 shrink-0 flex-col gap-2 border-l border-border pl-3 overflow-y-auto">
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
                        onClick={() => setConfirmState({ type: 'restore', target: snap.filename })}
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

      <Dialog open={confirmState.type !== null} onOpenChange={(o) => !o && setConfirmState({ type: null, target: null })}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmState.type === 'restore' ? 'Restore snapshot?' : 'Delete persona?'}
            </DialogTitle>
            <DialogDescription>
              {confirmState.type === 'restore'
                ? `Restore snapshot &quot;${confirmState.target}&quot;? Current soul will be overwritten.`
                : `Delete persona &quot;${confirmState.target}&quot;? This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmState({ type: null, target: null })}>
              Cancel
            </Button>
            {confirmState.type === 'restore' ? (
              <Button onClick={handleRestore}>Restore</Button>
            ) : (
              <Button variant="destructive" onClick={handleDelete}>Delete</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
