'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { SpecialistEvent } from '@/lib/agent/log-bus';

interface SpecialistRecord {
  specialistId: string;
  parentSessionId: string;
  taskDescription: string;
  contextSnapshot?: string;
  status: 'running' | 'complete' | 'error';
  result?: string;
  durationMs?: number;
  spawnedAt: string;
}

function applyEvent(map: Map<string, SpecialistRecord>, event: SpecialistEvent): Map<string, SpecialistRecord> {
  const next = new Map(map);
  if (event.kind === 'spawn') {
    next.set(event.specialistId, {
      specialistId: event.specialistId,
      parentSessionId: event.parentSessionId,
      taskDescription: event.taskDescription,
      contextSnapshot: event.contextSnapshot,
      status: 'running',
      spawnedAt: event.timestamp,
    });
  } else if (event.kind === 'complete' || event.kind === 'error') {
    const existing = next.get(event.specialistId);
    next.set(event.specialistId, {
      ...(existing ?? {
        specialistId: event.specialistId,
        parentSessionId: event.parentSessionId,
        taskDescription: event.taskDescription,
        status: 'running',
        spawnedAt: event.timestamp,
      }),
      status: event.kind === 'complete' ? 'complete' : 'error',
      result: event.result,
      durationMs: event.durationMs,
    });
  }
  return next;
}

function statusVariant(status: SpecialistRecord['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'complete') return 'default';
  if (status === 'error') return 'destructive';
  return 'secondary'; // running
}

function statusLabel(status: SpecialistRecord['status']) {
  if (status === 'running') return 'running…';
  return status;
}

function SpecialistCard({ rec }: { rec: SpecialistRecord }) {
  const [showContext, setShowContext] = useState(false);
  const [showResult, setShowResult] = useState(false);

  return (
    <div className="border border-border rounded-lg p-4 font-mono text-xs bg-card flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={statusVariant(rec.status)} className="text-[10px] shrink-0">
          {statusLabel(rec.status)}
        </Badge>
        <span className="text-muted-foreground text-[10px]">{rec.specialistId.slice(0, 8)}…</span>
        <span className="text-muted-foreground text-[10px]">← {rec.parentSessionId}</span>
        {rec.durationMs !== undefined && (
          <span className="ml-auto text-muted-foreground text-[10px]">{(rec.durationMs / 1000).toFixed(1)}s</span>
        )}
        <span className="text-muted-foreground text-[10px]">{new Date(rec.spawnedAt).toLocaleTimeString()}</span>
      </div>

      <div className="text-foreground leading-relaxed">
        {rec.taskDescription}
      </div>

      {rec.contextSnapshot && (
        <div>
          <button
            className="text-[10px] text-teal-600 dark:text-teal-400 hover:underline"
            onClick={() => setShowContext((o) => !o)}
          >
            {showContext ? '▼' : '▶'} Context
          </button>
          {showContext && (
            <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-muted-foreground bg-muted/40 border border-border rounded p-2">
              {rec.contextSnapshot}
            </pre>
          )}
        </div>
      )}

      {rec.result && (
        <div>
          <button
            className="text-[10px] text-sky-600 dark:text-sky-400 hover:underline"
            onClick={() => setShowResult((o) => !o)}
          >
            {showResult ? '▼' : '▶'} Result
          </button>
          {showResult && (
            <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-foreground bg-muted/40 border border-border rounded p-2">
              {rec.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function OrchestrationPage() {
  const [records, setRecords] = useState<Map<string, SpecialistRecord>>(new Map());
  const [connected, setConnected] = useState(false);

  // Load persisted history so specialists survive page refresh
  useEffect(() => {
    fetch('/api/specialist/history')
      .then((r) => r.json())
      .then((events: SpecialistEvent[]) => {
        setRecords((prev) => {
          let map = new Map(prev);
          for (const event of events) map = applyEvent(map, event);
          return map;
        });
      })
      .catch(() => {});
  }, []);

  // Live SSE stream for new events
  useEffect(() => {
    const es = new EventSource('/api/specialist/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as SpecialistEvent;
        setRecords((prev) => applyEvent(prev, event));
      } catch {
        // ignore malformed
      }
    };

    return () => es.close();
  }, []);

  const items = Array.from(records.values()).reverse();
  const running = items.filter((r) => r.status === 'running').length;

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Orchestration Tree</h1>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`}
          title={connected ? 'Live' : 'Connecting…'}
        />
        {running > 0 && (
          <Badge variant="secondary" className="text-[10px]">{running} running</Badge>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{items.length} specialist(s)</span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setRecords(new Map())}
        >
          Clear
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3">
        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            No specialists spawned yet…
          </div>
        ) : (
          items.map((rec) => <SpecialistCard key={rec.specialistId} rec={rec} />)
        )}
      </div>
    </div>
  );
}
