'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
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

/** Page size for semantic-search results (one grid page). */
const SEARCH_PAGE_SIZE = 12;

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
  // `activeQuery` is the query the current results belong to; paging Next/Prev
  // reuses it so editing the input mid-page doesn't change what we page through.
  const [activeQuery, setActiveQuery] = useState('');
  const [searchPage, setSearchPage] = useState(0);

  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailTarget, setDetailTarget] = useState<MemoryPoint | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
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
  const runSearch = async (q: string, page: number) => {
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const params = new URLSearchParams({
        q,
        limit: String(SEARCH_PAGE_SIZE),
        offset: String(page * SEARCH_PAGE_SIZE),
      });
      if (scope) params.set('scope', scope);
      if (category) params.set('category', category);
      if (agent) params.set('agent', agent);
      const res = await fetch(`/api/memory/search?${params}`);
      const data: MemoryPoint[] = await res.json();
      setSearchResults(data);
      setActiveQuery(q);
      setSearchPage(page);
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = () => runSearch(searchQuery.trim(), 0);

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
    setActiveQuery('');
    setSearchPage(0);
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

  // ── Re-scope (private ⇄ shared) ───────────────────────────────────────────────
  const switchScope = async (ids: (string | number)[], newScope: 'private' | 'shared') => {
    if (ids.length === 0) return;
    setScopeBusy(true);
    try {
      const res = await fetch('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.map(String), scope: newScope }),
      });
      if (!res.ok) return;
      const idSet = new Set(ids.map(String));
      // When a scope filter is active and we moved items off it, they no longer
      // belong in the current view — drop them; otherwise patch the badge.
      const reconcile = (arr: MemoryPoint[]): MemoryPoint[] =>
        scope && scope !== newScope
          ? arr.filter((p) => !idSet.has(String(p.id)))
          : arr.map((p) =>
              idSet.has(String(p.id))
                ? { ...p, payload: { ...(p.payload ?? {}), scope: newScope } }
                : p,
            );
      setPoints((prev) => reconcile(prev));
      setSearchResults((prev) => (prev ? reconcile(prev) : prev));
      setDetailTarget((prev) =>
        prev && idSet.has(String(prev.id))
          ? { ...prev, payload: { ...(prev.payload ?? {}), scope: newScope } }
          : prev,
      );
    } finally {
      setScopeBusy(false);
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
          {searchResults.length} result{searchResults.length === 1 ? '' : 's'} on page {searchPage + 1} for <span className="font-mono">&quot;{activeQuery}&quot;</span>
          {scope ? ` · scope: ${scope}` : ''}
          {category ? ` · type: ${category.replace(/_/g, ' ')}` : ''}
          {agent ? ` · agent: @${agent}` : ''}
        </p>
      )}

      {/* ── Bulk scope actions (whatever is currently on the page) ──────────── */}
      {!loading && !searching && displayPoints.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap shrink-0 text-xs text-muted-foreground">
          <span>{displayPoints.length} on page:</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={scopeBusy}
            onClick={() => switchScope(displayPoints.map((p) => p.id), 'shared')}
          >
            All → shared
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={scopeBusy}
            onClick={() => switchScope(displayPoints.map((p) => p.id), 'private')}
          >
            All → private
          </Button>
        </div>
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
                  <p
                    className="text-xs whitespace-pre-wrap break-words line-clamp-6 font-mono cursor-pointer"
                    onClick={() => setDetailTarget(p)}
                    title="Click to expand"
                  >
                    {text}
                  </p>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs text-muted-foreground">{formatTs(pl.timestamp)}</span>
                    <div className="flex items-center gap-1.5">
                      {(() => {
                        const target = String(pl.scope) === 'shared' ? 'private' : 'shared';
                        return (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8"
                            disabled={scopeBusy}
                            onClick={() => switchScope([p.id], target)}
                            title={`Switch this memory to ${target}`}
                            aria-label={`Switch memory entry ${p.id} to ${target}`}
                          >
                            → {target}
                          </Button>
                        );
                      })()}
                      <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => setDetailTarget(p)} aria-label={`Expand memory entry ${p.id}`}>
                        <Maximize2 className="size-3.5" />
                      </Button>
                      <Button variant="destructive" size="sm" className="h-8" onClick={() => setDeleteTarget(p.id)} aria-label={`Delete memory entry ${p.id}`}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Pagination (pinned at bottom) ───────────────────────────────────── */}
      {!isSearchMode ? (
        <div className="flex justify-end gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => { setOffset(null); fetchBrowse(scope, category, agent, null); }} disabled={offset == null} aria-label="Previous page of memories">
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setOffset(nextOffset); fetchBrowse(scope, category, agent, nextOffset); }} disabled={nextOffset == null} aria-label="Next page of memories">
            Next
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">Page {searchPage + 1}</span>
          <Button variant="outline" size="sm" onClick={() => runSearch(activeQuery, searchPage - 1)} disabled={searching || searchPage === 0} aria-label="Previous page of search results">
            Previous
          </Button>
          {/* A full page implies there may be more; a short page is the last one. */}
          <Button variant="outline" size="sm" onClick={() => runSearch(activeQuery, searchPage + 1)} disabled={searching || searchResults.length < SEARCH_PAGE_SIZE} aria-label="Next page of search results">
            Next
          </Button>
        </div>
      )}

      {/* Maximized card / full-text detail dialog */}
      <Dialog open={detailTarget !== null} onOpenChange={(o) => !o && setDetailTarget(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Memory entry</DialogTitle>
            <DialogDescription>Full text and metadata for this recall note.</DialogDescription>
          </DialogHeader>
          {detailTarget && (() => {
            const pl = detailTarget.payload ?? {};
            return (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{String(pl.scope ?? '-')}</Badge>
                  {pl.category != null && pl.category !== '' && (
                    <Badge variant="secondary">{String(pl.category).replace(/_/g, ' ')}</Badge>
                  )}
                  {pl.agent != null && pl.agent !== '' && (
                    <span className="text-xs text-muted-foreground font-mono">@{String(pl.agent)}</span>
                  )}
                </div>
                <div className="max-h-[55vh] overflow-auto rounded-md border border-border bg-muted/30 p-3">
                  <p className="text-xs whitespace-pre-wrap break-words font-mono">{String(pl.text ?? '')}</p>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>ID: <span className="font-mono">{String(detailTarget.id)}</span></span>
                  <span>{formatTs(pl.timestamp)}</span>
                  {detailTarget.score != null && <span>score: {detailTarget.score.toFixed(3)}</span>}
                </div>
                <DialogFooter>
                  {(() => {
                    const target = String(pl.scope) === 'shared' ? 'private' : 'shared';
                    return (
                      <Button variant="outline" disabled={scopeBusy} onClick={() => switchScope([detailTarget.id], target)}>
                        Switch to {target}
                      </Button>
                    );
                  })()}
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

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
