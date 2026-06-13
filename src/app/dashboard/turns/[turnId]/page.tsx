'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorkflowProvider } from '@/components/workflow/WorkflowCanvas';
import { TurnCanvas } from '@/components/workflow/turn/TurnCanvas';
import { TurnInspector } from '@/components/workflow/turn/TurnInspector';
import { buildTurnGraph } from '@/components/workflow/turn/turn-graph';
import type { TurnData, TurnNodeData } from '@/components/workflow/turn/turn-graph';
import type { SpecialistEvent, StepEvent } from '@/lib/agent/log-bus';

const REFETCH_DEBOUNCE_MS = 600;

export default function TurnViewPage() {
  const params = useParams<{ turnId: string }>();
  const turnId = params.turnId;
  const router = useRouter();

  const [data, setData] = useState<TurnData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [specialistSteps, setSpecialistSteps] = useState<Map<string, StepEvent[]>>(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadTurn = useCallback(() => {
    fetch(`/api/turns/${turnId}`)
      .then((res) => {
        if (res.status === 404) {
          setNotFound(true);
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((json: TurnData | null) => {
        if (!json) return;
        setData(json);
        setNotFound(false);
      })
      .catch(() => {
        // transient — user can hit Refresh
      });
  }, [turnId]);

  const loadSpecialistSteps = useCallback((specialistId: string) => {
    fetch(`/api/logs/steps?specialistId=${specialistId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((steps: StepEvent[] | null) => {
        if (!steps) return;
        setSpecialistSteps((prev) => new Map(prev).set(specialistId, Array.isArray(steps) ? steps : []));
      })
      .catch(() => {
        // leave the node in loading state; collapse/expand retries
      });
  }, []);

  useEffect(() => { loadTurn(); }, [loadTurn]);

  // ── Live updates: debounced refetch on matching SSE events ─────────────────

  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const expandedRef = useRef(expanded);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetchSpecialists = new Set<string>();

    const scheduleRefetch = (specialistId?: string) => {
      if (specialistId && expandedRef.current.has(specialistId)) {
        refetchSpecialists.add(specialistId);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        loadTurn();
        for (const id of refetchSpecialists) loadSpecialistSteps(id);
        refetchSpecialists.clear();
      }, REFETCH_DEBOUNCE_MS);
    };

    const knownSpecialist = (id: string | undefined) =>
      !!id && (dataRef.current?.specialists.some((s) => s.specialistId === id) ?? false);

    const stepStream = new EventSource('/api/logs/stream');
    stepStream.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as StepEvent;
        if (event.turnId === turnId || knownSpecialist(event.specialistId)) {
          scheduleRefetch(event.specialistId);
        }
      } catch { /* ignore malformed */ }
    };

    const specStream = new EventSource('/api/specialist/stream');
    specStream.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as SpecialistEvent;
        if (event.turnId === turnId || knownSpecialist(event.specialistId) || knownSpecialist(event.parentSpecialistId)) {
          scheduleRefetch();
        }
      } catch { /* ignore malformed */ }
    };

    return () => {
      if (timer) clearTimeout(timer);
      stepStream.close();
      specStream.close();
    };
  }, [turnId, loadTurn, loadSpecialistSteps]);

  // ── Interactions ────────────────────────────────────────────────────────────

  const toggleSpecialist = useCallback((specialistId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(specialistId)) {
        next.delete(specialistId);
      } else {
        next.add(specialistId);
      }
      return next;
    });
    if (!specialistSteps.has(specialistId)) {
      loadSpecialistSteps(specialistId);
    }
  }, [specialistSteps, loadSpecialistSteps]);

  const expandAll = useCallback(() => {
    if (!data) return;
    setExpanded(new Set(data.specialists.map((s) => s.specialistId)));
    for (const s of data.specialists) {
      if (!specialistSteps.has(s.specialistId)) loadSpecialistSteps(s.specialistId);
    }
  }, [data, specialistSteps, loadSpecialistSteps]);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  // Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedNodeId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Graph ───────────────────────────────────────────────────────────────────

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return buildTurnGraph(data, expanded, specialistSteps);
  }, [data, expanded, specialistSteps]);

  const displayNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId],
  );

  const selectedData = useMemo(() => {
    const node = nodes.find((n) => n.id === selectedNodeId);
    return (node?.data as TurnNodeData | undefined) ?? null;
  }, [nodes, selectedNodeId]);

  // ── Header facts ────────────────────────────────────────────────────────────

  const userMsg = data?.messages.find((m) => m.role === 'user');
  const isRunning = !!data && !data.messages.some((m) => m.role === 'assistant');
  const toolCallCount = data?.steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0) ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-background shrink-0 flex-wrap">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => router.back()} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold text-sm">Turn</span>
          <span className="text-xs text-muted-foreground font-mono" title={turnId}>
            {turnId.slice(0, 8)}
          </span>
          {userMsg && (
            <span className="text-xs text-muted-foreground truncate hidden sm:inline">
              · {new Date(userMsg.createdAt).toLocaleString()} · {userMsg.chatId}
              {userMsg.agentId ? ` · ${userMsg.agentId}` : ''}
            </span>
          )}
        </div>
        {isRunning && (
          <Badge className="text-[10px] bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" /> running
          </Badge>
        )}
        {data && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {data.steps.length} step{data.steps.length === 1 ? '' : 's'} · {toolCallCount} tool call{toolCallCount === 1 ? '' : 's'} · {data.specialists.length} specialist{data.specialists.length === 1 ? '' : 's'}
          </span>
        )}
        {data && data.specialists.length > 0 && (
          expanded.size > 0 ? (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={collapseAll}>
              Collapse all
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={expandAll}>
              Expand all
            </Button>
          )
        )}
        <Button variant="outline" size="sm" className="h-7" onClick={loadTurn} title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas */}
        <div className="flex-1 relative">
          {!data && !notFound && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-muted-foreground text-sm">
              <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading turn…
            </div>
          )}
          {notFound && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-muted-foreground text-sm">
              Turn not found — it may predate step recording.
            </div>
          )}
          <WorkflowProvider>
            <TurnCanvas
              nodes={displayNodes}
              edges={edges}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              onToggleSpecialist={toggleSpecialist}
            />
          </WorkflowProvider>
        </div>

        {/* Inspector */}
        <div className="w-80 border-l border-border bg-background shrink-0 overflow-y-auto">
          <TurnInspector data={selectedData} />
        </div>
      </div>
    </div>
  );
}
