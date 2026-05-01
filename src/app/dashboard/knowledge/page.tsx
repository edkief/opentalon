'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  const fetchBrowse = useCallback(async (scopeFilter: string, pageOffset: string | number | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (scopeFilter) params.set('scope', scopeFilter);
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
    fetchBrowse(scope, null);
  }, [scope, fetchBrowse]);

  // ── Search ──────────────────────────────────────────────────────────────────
  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q, limit: '20' });
      if (scope) params.set('scope', scope);
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
        <h1 className="text-lg font-semibold">Memory Explorer</h1>
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
          <Button variant="outline" size="sm" onClick={() => fetchBrowse(scope, offset)} aria-label="Refresh memory list">
            Refresh
          </Button>
        </div>
      </div>

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
        </p>
      )}

      {/* ── Table (flex-1 so it fills remaining height, scrolls internally) ── */}
      <div className="flex-1 min-h-0 overflow-auto border border-border rounded-md">
        <Table>
          <caption className="sr-only">Memory entries with scope, author, timestamp, and text content</caption>
          <TableHeader className="sticky top-0 bg-background z-10">
            <TableRow>
              {isSearchMode && <TableHead className="w-16">Score</TableHead>}
              <TableHead className="w-20">Scope</TableHead>
              <TableHead className="w-24">Author</TableHead>
              <TableHead className="w-36">Timestamp</TableHead>
              <TableHead>Text</TableHead>
              <TableHead className="w-20 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(loading || searching) && (
              <TableRow>
                <TableCell colSpan={isSearchMode ? 6 : 5} className="text-center text-muted-foreground py-8">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {!loading && !searching && displayPoints.length === 0 && (
              <TableRow>
                <TableCell colSpan={isSearchMode ? 6 : 5} className="text-center text-muted-foreground py-8">
                  {isSearchMode ? 'No results found' : 'No memories found'}
                </TableCell>
              </TableRow>
            )}
            {!loading && !searching && displayPoints.map((p) => {
              const pl = p.payload ?? {};
              const text = String(pl.text ?? '');
              return (
                <TableRow key={String(p.id)}>
                  {isSearchMode && (
                    <TableCell className="font-mono text-xs tabular-nums">
                      {p.score != null ? p.score.toFixed(3) : '-'}
                    </TableCell>
                  )}
                  <TableCell>
                    <Badge variant="outline">{String(pl.scope ?? '-')}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{String(pl.author ?? '-')}</TableCell>
                  <TableCell className="font-mono text-xs">{formatTs(pl.timestamp)}</TableCell>
                  <TableCell className="font-mono text-xs max-w-sm">
                    <span className="line-clamp-2" title={text}>{text}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(p.id)} aria-label={`Delete memory entry ${p.id}`}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* ── Pagination (browse mode only, pinned at bottom) ─────────────────── */}
      {!isSearchMode && (
        <div className="flex justify-end gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => { setOffset(null); fetchBrowse(scope, null); }} disabled={offset == null} aria-label="Previous page of memories">
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setOffset(nextOffset); fetchBrowse(scope, nextOffset); }} disabled={nextOffset == null} aria-label="Next page of memories">
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
