'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { RECALL_CATEGORIES, RECALL_CATEGORY_DESCRIPTIONS } from '@/lib/memory/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemoryPoint {
  id: string | number;
  score?: number;
  payload: Record<string, unknown> | null;
}

interface BrowseResult {
  points: MemoryPoint[];
  nextOffset: string | number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** timestamp is stored as Date.now() (ms number) — must cast to number before Date constructor */
function formatTs(raw: unknown): string {
  if (raw == null || raw === '') return '-';
  const ms = typeof raw === 'number' ? raw : Number(raw);
  if (isNaN(ms)) return '-';
  return new Date(ms).toLocaleString();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MemoryPage() {
  // Browse state
  const [scope, setScope] = useState('');
  const [category, setCategory] = useState('');
  const [agent, setAgent] = useState('');
  const [agents, setAgents] = useState<string[]>([]);
  const [defaultAgent, setDefaultAgent] = useState('');
  const [points, setPoints] = useState<MemoryPoint[]>([]);
  const [nextOffset, setNextOffset] = useState<string | number | null>(null);
  const [offset, setOffset] = useState<string | number | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemoryPoint[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── Browse ──────────────────────────────────────────────────────────────────
  // Agent roster for the agent filter (default agent's notes are untagged).
  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((d: { agents?: { id: string }[]; defaultAgent?: string }) => {
        setAgents((d.agents ?? []).map((a) => a.id));
        setDefaultAgent(d.defaultAgent ?? '');
      })
      .catch(() => { /* filter simply stays hidden */ });
  }, []);

  const fetchBrowse = useCallback(async (scopeFilter: string, categoryFilter: string, agentFilter: string, pageOffset: string | number | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (scopeFilter) params.set('scope', scopeFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (agentFilter) params.set('agent', agentFilter);
      if (pageOffset != null) params.set('offset', String(pageOffset));
      const res = await fetch(`/api/memory?${params}`);
      const data: BrowseResult = await res.json();
      setPoints(data.points);
      setNextOffset(data.nextOffset);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOffset(null);
    setSearchResults(null);
    fetchBrowse(scope, category, agent, null);
  }, [scope, category, agent, fetchBrowse]);

  // ── Search ──────────────────────────────────────────────────────────────────
  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q, limit: '20' });
      if (scope) params.set('scope', scope);
      if (category) params.set('category', category);
      if (agent) params.set('agent', agent);
      const res = await fetch(`/api/memory/search?${params}`);
      const data: MemoryPoint[] = await res.json();
      setSearchResults(data);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
    searchInputRef.current?.focus();
  };

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (deleteTarget === null) return;
    setDeleting(true);
    try {
      await fetch(`/api/memory/${deleteTarget}`, { method: 'DELETE' });
      setPoints((prev) => prev.filter((p) => p.id !== deleteTarget));
      setSearchResults((prev) => prev?.filter((p) => p.id !== deleteTarget) ?? null);
    } finally {
      setDeleteTarget(null);
      setDeleting(false);
    }
  };

  const isSearchMode = searchResults !== null;
  const displayPoints = isSearchMode ? searchResults : points;

  return (
    <div className="flex flex-col h-full gap-3">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Recall</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Vector-store memory — retrieved on demand, not always-on. Browse, search, and curate.
          </p>
        </div>
        <div className="flex gap-1.5">
          {(['', 'private', 'shared'] as const).map((s) => (
            <Button
              key={s || 'all'}
              variant={scope === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setScope(s)}
            >
              {s || 'All'}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={() => fetchBrowse(scope, category, agent, offset)} aria-label="Refresh memory list">
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Category filter ────────────────────────────────────────────────── */}
      <div className="flex gap-1.5 flex-wrap shrink-0">
        <Button
          variant={category === '' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setCategory('')}
          title="All memory types"
        >
          All types
        </Button>
        {RECALL_CATEGORIES.map((c) => (
          <Button
            key={c}
            variant={category === c ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCategory(c)}
            title={RECALL_CATEGORY_DESCRIPTIONS[c]}
          >
            {c.replace(/_/g, ' ')}
          </Button>
        ))}
      </div>

      {/* ── Agent filter (only when more than one agent exists) ─────────────── */}
      {agents.length > 1 && (
        <div className="flex gap-1.5 flex-wrap shrink-0">
          <Button
            variant={agent === '' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAgent('')}
            title="All agents"
          >
            All agents
          </Button>
          {agents.map((a) => (
            <Button
              key={a}
              variant={agent === a ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAgent(a)}
              title={a === defaultAgent ? 'Default agent — untagged notes' : undefined}
            >
              @{a}{a === defaultAgent ? ' (default)' : ''}
            </Button>
          ))}
        </div>
      )}

      {/* ── Search bar ─────────────────────────────────────────────────────── */}
      <div className="flex gap-2 shrink-0">
        <div className="flex-1">
          <label htmlFor="memory-search" className="sr-only">Search memories</label>
          <Input
            id="memory-search"
            ref={searchInputRef}
            placeholder="Semantic search… (Enter to run)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1 text-sm"
          />
        </div>
        <Button onClick={handleSearch} disabled={searching || !searchQuery.trim()} size="sm" aria-label="Search memories">
          {searching ? 'Searching…' : 'Search'}
        </Button>
        {isSearchMode && (
          <Button variant="outline" size="sm" onClick={clearSearch}>
            Browse
          </Button>
        )}
      </div>

      {isSearchMode && (
        <p className="text-xs text-muted-foreground shrink-0">
          {searchResults.length} results for <span className="font-mono">&quot;{searchQuery}&quot;</span>
          {scope ? ` · scope: ${scope}` : ''}
          {category ? ` · type: ${category.replace(/_/g, ' ')}` : ''}
          {agent ? ` · agent: @${agent}` : ''}
        </p>
      )}

      {/* ── Card grid (all sizes) ────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-auto">
        {(loading || searching) && (
          <div className="flex items-center justify-center text-muted-foreground text-sm py-8">Loading…</div>
        )}
        {!loading && !searching && displayPoints.length === 0 && (
          <div className="flex items-center justify-center text-muted-foreground text-sm py-8">
            {isSearchMode ? 'No results found' : 'No memories found'}
          </div>
        )}
        {!loading && !searching && displayPoints.length > 0 && (
          <div className="grid gap-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {displayPoints.map((p) => {
              const pl = p.payload ?? {};
              const text = String(pl.text ?? '');
              return (
                <div key={String(p.id)} className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{String(pl.scope ?? '-')}</Badge>
                    {pl.category != null && pl.category !== '' && (
                      <Badge variant="secondary">{String(pl.category).replace(/_/g, ' ')}</Badge>
                    )}
                    {pl.agent != null && pl.agent !== '' && (
                      <span className="text-xs text-muted-foreground font-mono">@{String(pl.agent)}</span>
                    )}
                    {isSearchMode && p.score != null && (
                      <span className="text-xs font-mono text-muted-foreground ml-auto">score: {p.score.toFixed(3)}</span>
                    )}
                  </div>
                  <p className="text-xs whitespace-pre-wrap break-words line-clamp-6 font-mono">{text}</p>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs text-muted-foreground">{formatTs(pl.timestamp)}</span>
                    <Button variant="destructive" size="sm" className="h-8" onClick={() => setDeleteTarget(p.id)} aria-label={`Delete memory entry ${p.id}`}>
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Pagination (browse mode only, pinned at bottom) ─────────────────── */}
      {!isSearchMode && (
        <div className="flex justify-end gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => { setOffset(null); fetchBrowse(scope, category, agent, null); }} disabled={offset == null} aria-label="Previous page of memories">
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setOffset(nextOffset); fetchBrowse(scope, category, agent, nextOffset); }} disabled={nextOffset == null} aria-label="Next page of memories">
            Next
          </Button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete memory entry?</DialogTitle>
            <DialogDescription>
            This will permanently remove the memory entry. This action cannot be undone.
          </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
