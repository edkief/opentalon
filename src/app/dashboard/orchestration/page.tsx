'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RestartModal } from '@/components/restart-modal';
import type { SpecialistEvent, StepEvent } from '@/lib/agent/log-bus';

interface SpecialistRecord {
  specialistId: string;
  parentSessionId: string;
  taskDescription: string;
  contextSnapshot?: string;
  status: 'running' | 'complete' | 'error' | 'max_steps';
  result?: string;
  durationMs?: number;
  maxStepsUsed?: number;
  canResume?: boolean;
  background?: boolean;
  spawnedAt: string;
  parentSpecialistId?: string;
  steps: StepEvent[];
  agentId?: string;
  modelUsed?: string;
}

function applyEvent(map: Map<string, SpecialistRecord>, event: SpecialistEvent): Map<string, SpecialistRecord> {
  const next = new Map(map);
  if (event.kind === 'spawn') {
    const existing = next.get(event.specialistId);
    next.set(event.specialistId, {
      specialistId: event.specialistId,
      parentSessionId: event.parentSessionId,
      taskDescription: event.taskDescription,
      contextSnapshot: event.contextSnapshot,
      status: 'running',
      spawnedAt: event.timestamp,
      background: event.background,
      parentSpecialistId: event.parentSpecialistId,
      steps: existing?.steps ?? [],
      agentId: event.agentId ?? existing?.agentId,
      modelUsed: existing?.modelUsed,
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
        steps: [],
      }),
      status: event.kind === 'complete' ? 'complete' : 'error',
      result: event.result,
      durationMs: event.durationMs,
      background: event.background,
      parentSpecialistId: event.parentSpecialistId ?? existing?.parentSpecialistId,
      steps: existing?.steps ?? [],
      agentId: event.agentId ?? existing?.agentId,
      modelUsed: event.modelUsed ?? existing?.modelUsed,
    });
  } else if (event.kind === 'max_steps') {
    const existing = next.get(event.specialistId);
    next.set(event.specialistId, {
      ...(existing ?? {
        specialistId: event.specialistId,
        parentSessionId: event.parentSessionId,
        taskDescription: event.taskDescription,
        status: 'running',
        spawnedAt: event.timestamp,
        steps: [],
      }),
      status: 'max_steps',
      result: event.result,
      durationMs: event.durationMs,
      maxStepsUsed: event.maxStepsUsed,
      canResume: event.canResume,
      background: event.background,
      parentSpecialistId: event.parentSpecialistId ?? existing?.parentSpecialistId,
      steps: existing?.steps ?? [],
      agentId: event.agentId ?? existing?.agentId,
      modelUsed: event.modelUsed ?? existing?.modelUsed,
    });
  }
  return next;
}

function applyStep(map: Map<string, SpecialistRecord>, step: StepEvent): Map<string, SpecialistRecord> {
  if (!step.specialistId) return map;
  const rec = map.get(step.specialistId);
  if (!rec) return map;
  // Avoid duplicates on history replay
  if (rec.steps.some((s) => s.id === step.id)) return map;
  const next = new Map(map);
  next.set(step.specialistId, { ...rec, steps: [...rec.steps, step] });
  return next;
}

function statusVariant(status: SpecialistRecord['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'complete') return 'default';
  if (status === 'error') return 'destructive';
  if (status === 'max_steps') return 'outline';
  return 'secondary'; // running
}

function statusLabel(status: SpecialistRecord['status']) {
  if (status === 'running') return 'running…';
  if (status === 'max_steps') return 'max steps';
  return status;
}

function StepDetail({ step }: { step: StepEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-border rounded p-2 bg-muted/30 text-[10px] font-mono">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted-foreground">step {step.stepIndex} · {step.finishReason}</span>
        <button
          className="ml-auto text-[10px] text-violet-600 dark:text-violet-300 hover:underline"
          onClick={() => setExpanded((o) => !o)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {expanded ? (
        <pre className="whitespace-pre-wrap break-all text-[11px] text-foreground">
          {JSON.stringify(step, null, 2)}
        </pre>
      ) : (
        <>
          {step.toolCalls?.map((tc, i) => (
            <div key={i} className="text-amber-600 dark:text-amber-400 break-all">
              → {tc.toolName}({JSON.stringify(tc.input).slice(0, 160)})
            </div>
          ))}
          {step.toolResults?.map((tr, i) => (
            <div key={i} className="text-green-700 dark:text-green-400 break-all">
              ← {tr.toolName}: {tr.output.slice(0, 160)}
            </div>
          ))}
          {step.text && (
            <div className="text-foreground/70 break-all mt-0.5">{step.text.slice(0, 240)}</div>
          )}
        </>
      )}
    </div>
  );
}

function StepsAccordion({ steps }: { steps: StepEvent[] }) {
  const [open, setOpen] = useState(false);
  const toolSteps = steps.filter((s) => (s.toolCalls?.length ?? 0) > 0 || (s.toolResults?.length ?? 0) > 0 || s.text);
  if (toolSteps.length === 0) return null;

  return (
    <div>
      <button
        className="text-[10px] text-violet-600 dark:text-violet-400 hover:underline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? '▼' : '▶'} Steps ({toolSteps.length})
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {toolSteps.map((step) => (
            <StepDetail key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function SpecialistCard({ rec, depth = 0 }: { rec: SpecialistRecord; depth?: number }) {
  const [showContext, setShowContext] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const handleResume = async (additionalSteps?: number) => {
    try {
      const url = additionalSteps
        ? `/api/specialist/resume?jobId=${rec.specialistId}&additionalSteps=${additionalSteps}`
        : `/api/specialist/resume?jobId=${rec.specialistId}`;
      const res = await fetch(url, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        alert(`Task resumed! New job ID: ${data.jobId}`);
      } else {
        const err = await res.text();
        alert(`Failed to resume: ${err}`);
      }
    } catch (e) {
      alert(`Error: ${e}`);
    }
  };

  return (
    <div
      className="border border-border rounded-lg p-4 font-mono text-xs bg-card flex flex-col gap-2"
      style={depth > 0 ? { marginLeft: `${depth * 20}px` } : undefined}
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-1 sm:gap-2 flex-wrap">
        <Badge variant={statusVariant(rec.status)} className="text-[10px] shrink-0">
          {statusLabel(rec.status)}
        </Badge>
        {rec.background && (
          <Badge variant="secondary" className="text-[10px] shrink-0 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            bg
          </Badge>
        )}
        {depth > 0 && (
          <Badge variant="outline" className="text-[10px] shrink-0 text-muted-foreground">
            sub-agent
          </Badge>
        )}
        {rec.agentId && (
          <span className="text-indigo-600 dark:text-indigo-400 text-[10px] font-medium shrink-0">
            {rec.agentId}
          </span>
        )}
        {rec.modelUsed && (
          <span className="text-muted-foreground text-[10px] font-mono shrink-0">
            {rec.modelUsed}
          </span>
        )}
        {rec.maxStepsUsed !== undefined && (
          <span className="text-amber-600 dark:text-amber-400 text-[10px] font-medium">
            {rec.maxStepsUsed} steps
          </span>
        )}
        <span className="text-muted-foreground text-[10px] font-mono break-all">{rec.specialistId}</span>
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
            aria-expanded={showContext}
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

      <StepsAccordion steps={rec.steps} />

      {rec.result && (
        <div>
          <button
            className="text-[10px] text-sky-600 dark:text-sky-400 hover:underline"
            onClick={() => setShowResult((o) => !o)}
            aria-expanded={showResult}
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

      {rec.status === 'max_steps' && rec.canResume && (
        <div className="flex gap-2 mt-1">
          <Button
            variant="outline"
            size="sm"
            className="text-[10px] h-6"
            onClick={() => handleResume(rec.maxStepsUsed)}
          >
            Resume ({rec.maxStepsUsed ?? 15} steps)
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-[10px] h-6"
            onClick={() => handleResume(30)}
          >
            Resume +30
          </Button>
        </div>
      )}
    </div>
  );
}

function renderTree(
  items: SpecialistRecord[],
  parentSpecialistId: string | undefined,
  depth: number,
): React.ReactNode[] {
  return items
    .filter((r) => r.parentSpecialistId === parentSpecialistId)
    .map((rec) => [
      <SpecialistCard key={rec.specialistId} rec={rec} depth={depth} />,
      ...renderTree(items, rec.specialistId, depth + 1),
    ])
    .flat();
}

export default function OrchestrationPage() {
  const [records, setRecords] = useState<Map<string, SpecialistRecord>>(new Map());
  const [connected, setConnected] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);

  // Load persisted history so specialists survive page refresh
  useEffect(() => {
    fetch('/api/specialist/history')
      .then((r) => r.json())
      .then((events: SpecialistEvent[]) => {
        let map = new Map<string, SpecialistRecord>();
        for (const event of events) map = applyEvent(map, event);

        // Also load step history and match to specialists by specialistId
        fetch('/api/logs/steps')
          .then((r) => r.json())
          .then((steps: StepEvent[]) => {
            for (const step of steps) map = applyStep(map, step);
            setRecords(map);
          })
          .catch(() => setRecords(map));
      })
      .catch(() => {});
  }, []);

  // Live SSE stream for new specialist events
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

  // Live SSE stream for step events — filter to those with a specialistId
  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (e) => {
      try {
        const step = JSON.parse(e.data) as StepEvent;
        if (step.specialistId) {
          setRecords((prev) => applyStep(prev, step));
        }
      } catch {
        // ignore malformed
      }
    };
    return () => es.close();
  }, []);

  const items = Array.from(records.values()).sort(
    (a, b) => new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime(),
  );
  const running = items.filter((r) => r.status === 'running').length;
  const rootItems = items.filter((r) => !r.parentSpecialistId);

  return (
    <div className="flex flex-col h-full gap-4">
      <RestartModal open={restartOpen} onOpenChange={setRestartOpen} />
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
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => setRecords(new Map())}
        >
          Clear
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRestartOpen(true)}
        >
          Restart Services
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3">
        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            No specialists spawned yet…
          </div>
        ) : (
          rootItems.flatMap((root) => [
            <SpecialistCard key={root.specialistId} rec={root} depth={0} />,
            ...renderTree(items, root.specialistId, 1),
          ])
        )}
      </div>
    </div>
  );
}
