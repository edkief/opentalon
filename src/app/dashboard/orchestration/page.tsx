'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RestartModal } from '@/components/restart-modal';
import type { SpecialistEvent, SpecialistSummary, StepEvent } from '@/lib/agent/log-bus';
import { parseTodoOutput, TODO_TOOL_NAMES } from '@/lib/agent/todo-utils';
import type { ParsedTodo } from '@/lib/agent/todo-utils';
import { ChevronDown, ChevronRight, Workflow, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SpecialistRecord extends SpecialistSummary {
  steps: StepEvent[];
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
      turnId: event.turnId ?? existing?.turnId,
    });
  } else if (event.kind === 'complete' || event.kind === 'error' || event.kind === 'cancelled') {
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
      status: event.kind === 'complete' ? 'complete' : event.kind === 'cancelled' ? 'cancelled' : 'error',
      result: event.result,
      durationMs: event.durationMs,
      background: event.background,
      parentSpecialistId: event.parentSpecialistId ?? existing?.parentSpecialistId,
      steps: existing?.steps ?? [],
      agentId: event.agentId ?? existing?.agentId,
      modelUsed: event.modelUsed ?? existing?.modelUsed,
      turnId: event.turnId ?? existing?.turnId,
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
      turnId: event.turnId ?? existing?.turnId,
    });
  }
  return next;
}

function applyStep(map: Map<string, SpecialistRecord>, step: StepEvent): Map<string, SpecialistRecord> {
  if (!step.specialistId) return map;
  const rec = map.get(step.specialistId);
  if (!rec) return map;
  const next = new Map(map);
  // A step is emitted progressively (thinking → responding → tools → done) under
  // one id, so replace it in place rather than dropping the later, richer emits.
  // Falls back to append for the first emit and for legacy history replay.
  const existing = rec.steps.findIndex((s) => s.id === step.id);
  if (existing === -1) {
    next.set(step.specialistId, { ...rec, steps: [...rec.steps, step] });
  } else {
    const steps = [...rec.steps];
    steps[existing] = step;
    next.set(step.specialistId, { ...rec, steps });
  }
  return next;
}

function statusVariant(status: SpecialistRecord['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'complete') return 'default';
  if (status === 'error') return 'destructive';
  if (status === 'max_steps') return 'outline';
  if (status === 'cancelled') return 'destructive';
  return 'secondary'; // running
}

function statusLabel(status: SpecialistRecord['status']) {
  if (status === 'running') return 'running…';
  if (status === 'max_steps') return 'max steps';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

/** Full locale timestamp (date + time + seconds) for hover tooltips. */
function formatExact(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Compact inline label, e.g. "Jun 12, 14:32". */
function formatShort(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Relative time, e.g. "just now", "5m ago", "2h ago", "3d ago". */
function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** Builds the optional chatId/agentId query string for the turn viewer link. */
function turnLinkQuery(rec: SpecialistRecord): string {
  const params = new URLSearchParams();
  if (rec.parentSessionId) params.set('chatId', rec.parentSessionId);
  if (rec.agentId) params.set('agentId', rec.agentId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard unavailable — no-op
  }
}

const TODO_ACTION_LABELS: Record<string, string> = {
  todo_create: 'Created todo list',
  todo_add: 'Added tasks',
  todo_update: 'Updated task',
  todo_clear: 'Cleared todo list',
};

function TodoResultCard({ toolName, output }: { toolName: string; output: string }) {
  const parsed: ParsedTodo | null = parseTodoOutput(output);
  const isCleared = output.trim() === 'Todo list cleared.';
  const actionLabel = TODO_ACTION_LABELS[toolName] ?? toolName;
  const done = parsed ? parsed.items.filter(i => i.done).length : 0;
  const total = parsed ? parsed.items.length : 0;

  return (
    <div className="border border-violet-300 dark:border-violet-700 rounded p-2 bg-violet-50/40 dark:bg-violet-950/20 text-[10px] font-mono mt-1">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-violet-600 dark:text-violet-300 font-semibold">{actionLabel}</span>
        {parsed && (
          <span className="text-muted-foreground">
            {done}/{total} done
          </span>
        )}
        {isCleared && <span className="text-muted-foreground italic">list cleared</span>}
      </div>
      {parsed && (
        <>
          <div className="text-foreground font-medium mb-1 text-[11px] truncate">{parsed.goal}</div>
          <ul className="flex flex-col gap-0.5">
            {parsed.items.map((item) => (
              <li key={item.id} className="flex items-start gap-1.5">
                <span className={['mt-0.5 shrink-0', item.done ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'].join(' ')}>
                  {item.done ? '✓' : '○'}
                </span>
                <span className={['break-words leading-relaxed flex-1', item.done ? 'line-through text-muted-foreground' : 'text-foreground'].join(' ')}>
                  {item.text}
                </span>
                <span className="shrink-0 text-muted-foreground/50 pl-2 tabular-nums">{item.id}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function OrchestraReasoningToggle({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] text-purple-600 dark:text-purple-400 hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Chain of thought
      </button>
      {open && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-purple-700 dark:text-purple-300 bg-purple-50/60 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800/40 rounded p-2">
          {reasoning}
        </pre>
      )}
    </div>
  );
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
          {step.reasoning && step.reasoning !== '[object Object]' && (
            <OrchestraReasoningToggle reasoning={step.reasoning} />
          )}
          {step.toolCalls?.map((tc, i) => (
            <div key={i} className="text-amber-600 dark:text-amber-400 break-all">
              → {tc.toolName}({JSON.stringify(tc.input).slice(0, 160)})
            </div>
          ))}
          {step.toolResults?.map((tr, i) =>
            TODO_TOOL_NAMES.has(tr.toolName) ? (
              <TodoResultCard key={i} toolName={tr.toolName} output={tr.output} />
            ) : (
              <div key={i} className="text-green-700 dark:text-green-400 break-all">
                ← {tr.toolName}: {tr.output.slice(0, 160)}
              </div>
            )
          )}
          {step.text && (
            <div className="text-foreground/70 break-all mt-0.5">{step.text.slice(0, 240)}</div>
          )}
        </>
      )}
    </div>
  );
}

function StepsAccordion({
  steps,
  stepsLoaded,
  onLoad,
}: {
  steps: StepEvent[];
  stepsLoaded: boolean;
  onLoad?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const loadCalled = useRef(false);

  const toolSteps = steps.filter(
    (s) => (s.toolCalls?.length ?? 0) > 0 || (s.toolResults?.length ?? 0) > 0 || s.text,
  );

  // Hide after load if there are no steps with content
  if (stepsLoaded && toolSteps.length === 0) return null;

  const handleToggle = () => {
    if (!open && !stepsLoaded && onLoad && !loadCalled.current) {
      loadCalled.current = true;
      onLoad();
    }
    setOpen((o) => !o);
  };

  return (
    <div>
      <button
        className="text-[10px] text-violet-600 dark:text-violet-400 hover:underline"
        onClick={handleToggle}
        aria-expanded={open}
      >
        {open ? '▼' : '▶'} Steps {stepsLoaded ? `(${toolSteps.length})` : '(?)'}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {!stepsLoaded ? (
            <div className="text-[10px] text-muted-foreground italic">Loading steps…</div>
          ) : (
            toolSteps.map((step) => <StepDetail key={step.id} step={step} />)
          )}
        </div>
      )}
    </div>
  );
}

function SpecialistCard({
  rec,
  depth = 0,
  stepsLoaded,
  onLoadSteps,
}: {
  rec: SpecialistRecord;
  depth?: number;
  stepsLoaded: boolean;
  onLoadSteps?: () => void;
}) {
  const [showContext, setShowContext] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!confirm('Cancel this specialist?')) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/specialist/cancel?jobId=${rec.specialistId}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.text();
        alert(`Failed to cancel: ${err}`);
      }
    } catch (e) {
      alert(`Error: ${e}`);
    } finally {
      setCancelling(false);
    }
  };

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
      style={depth > 0 ? { marginLeft: `${Math.min(depth, 3) * 12}px` } : undefined}
    >
      {/* Zone A — header: status / flags on the left, timing on the right */}
      <div className="flex items-center gap-2 flex-wrap">
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

        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span title={formatExact(rec.spawnedAt)} className="cursor-default">
            {formatShort(rec.spawnedAt)}
          </span>
          <span className="text-muted-foreground/70">· {formatRelative(rec.spawnedAt)}</span>
          {rec.durationMs !== undefined ? (
            <span className="text-foreground/70 tabular-nums">{(rec.durationMs / 1000).toFixed(1)}s</span>
          ) : rec.status === 'running' ? (
            <span className="text-muted-foreground/70">· running</span>
          ) : null}
          {rec.status !== 'running' && rec.updatedAt && rec.updatedAt !== rec.spawnedAt && (
            <span title={formatExact(rec.updatedAt)} className="cursor-default">
              → {formatShort(rec.updatedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Zone B — task description (headline) */}
      <div className="text-sm text-foreground font-medium leading-relaxed">
        {rec.taskDescription}
      </div>

      {/* Zone C — metadata footer: identity + copyable IDs */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] text-muted-foreground border-t border-border/50 pt-2">
        {rec.agentId && (
          <span className="text-indigo-600 dark:text-indigo-400 font-medium">{rec.agentId}</span>
        )}
        {rec.modelUsed && <span className="font-mono">{rec.modelUsed}</span>}
        {rec.maxStepsUsed !== undefined && (
          <span className="text-amber-600 dark:text-amber-400 font-medium">{rec.maxStepsUsed} steps</span>
        )}
        <button
          type="button"
          title={`Copy ID: ${rec.specialistId}`}
          onClick={() => copyToClipboard(rec.specialistId)}
          className="font-mono cursor-pointer hover:text-foreground"
        >
          {rec.specialistId.slice(0, 8)}…
        </button>
        <button
          type="button"
          title={`Copy parent: ${rec.parentSessionId}`}
          onClick={() => copyToClipboard(rec.parentSessionId)}
          className="font-mono cursor-pointer hover:text-foreground"
        >
          ← {rec.parentSessionId.slice(0, 8)}…
        </button>
        {rec.turnId && (
          <Link
            href={`/dashboard/turns/${rec.turnId}${turnLinkQuery(rec)}`}
            title="Inspect turn in viewer"
            aria-label="Inspect turn in viewer"
            className="ml-auto inline-flex items-center gap-1 text-violet-600 dark:text-violet-400 hover:text-foreground hover:underline"
          >
            <Workflow className="h-3 w-3" />
            Inspect turn
          </Link>
        )}
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

      <StepsAccordion steps={rec.steps} stepsLoaded={stepsLoaded} onLoad={onLoadSteps} />

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

      {rec.status === 'running' && (
        <div className="flex gap-2 mt-1">
          <Button
            variant="destructive"
            size="sm"
            className="text-[10px] h-8"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        </div>
      )}

      {rec.status === 'max_steps' && rec.canResume && (
        <div className="flex gap-2 mt-1">
          <Button
            variant="outline"
            size="sm"
            className="text-[10px] h-8"
            onClick={() => handleResume(rec.maxStepsUsed)}
          >
            Resume ({rec.maxStepsUsed ?? 15} steps)
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-[10px] h-8"
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
  loadedStepsIds: Set<string>,
  onLoadSteps: (id: string) => void,
): React.ReactNode[] {
  return items
    .filter((r) => r.parentSpecialistId === parentSpecialistId)
    .map((rec) => [
      <SpecialistCard
        key={rec.specialistId}
        rec={rec}
        depth={depth}
        stepsLoaded={loadedStepsIds.has(rec.specialistId) || rec.steps.length > 0}
        onLoadSteps={() => onLoadSteps(rec.specialistId)}
      />,
      ...renderTree(items, rec.specialistId, depth + 1, loadedStepsIds, onLoadSteps),
    ])
    .flat();
}

const PAGE_SIZE = 20;

export default function OrchestrationPage() {
  const [records, setRecords] = useState<Map<string, SpecialistRecord>>(new Map());
  const [connected, setConnected] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadedStepsIds, setLoadedStepsIds] = useState<Set<string>>(new Set());

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch paginated history when page or search changes
  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set('search', search);

    fetch(`/api/specialist/history?${params}`)
      .then((r) => r.json())
      .then(({ items, totalPages: tp }: { items: SpecialistSummary[]; totalPages: number }) => {
        setRecords((prev) => {
          // Preserve running specialists so live jobs aren't lost during page navigation
          const next = new Map<string, SpecialistRecord>(
            Array.from(prev.entries()).filter(([, v]) => v.status === 'running'),
          );
          for (const item of items) {
            if (!next.has(item.specialistId)) {
              next.set(item.specialistId, { ...item, steps: [] });
            }
          }
          return next;
        });
        setTotalPages(tp ?? 1);
      })
      .catch(() => {});
  }, [page, search]);

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

  const handleLoadSteps = async (specialistId: string) => {
    if (loadedStepsIds.has(specialistId)) return;
    try {
      const res = await fetch(`/api/logs/steps?specialistId=${specialistId}`);
      const steps: StepEvent[] = await res.json();
      setRecords((prev) => {
        const rec = prev.get(specialistId);
        if (!rec) return prev;
        const next = new Map(prev);
        next.set(specialistId, { ...rec, steps });
        return next;
      });
      setLoadedStepsIds((prev) => new Set([...prev, specialistId]));
    } catch {
      // ignore — user can retry by closing and reopening the accordion
    }
  };

  const items = Array.from(records.values()).sort(
    (a, b) => new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime(),
  );
  const running = items.filter((r) => r.status === 'running').length;
  const rootItems = items.filter((r) => !r.parentSpecialistId);

  return (
    <div className="flex flex-col h-full gap-4">
      <RestartModal open={restartOpen} onOpenChange={setRestartOpen} />
      {/* Header row 1: title + meta */}
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold">Orchestration Tree</h1>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`}
          title={connected ? 'Live' : 'Connecting…'}
        />
        {running > 0 && (
          <Badge variant="secondary" className="text-[10px]">{running} running</Badge>
        )}
        <span className="text-xs text-muted-foreground">{items.length} specialist(s)</span>
      </div>
      {/* Header row 2: search + actions */}
      <div className="flex items-center gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search runs…"
          className="h-7 text-xs flex-1"
        />
        {/* Actions visible on sm+ */}
        <Button
          variant="ghost"
          size="sm"
          className="text-xs hidden sm:inline-flex"
          onClick={() => setRecords(new Map())}
          aria-label="Clear all specialist records"
        >
          Clear
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hidden sm:inline-flex"
          onClick={() => setRestartOpen(true)}
        >
          Restart Services
        </Button>
        {/* Overflow menu on phones */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 sm:hidden" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setRecords(new Map())}>
              Clear records
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRestartOpen(true)}>
              Restart Services
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3">
        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            No specialists spawned yet…
          </div>
        ) : (
          rootItems.flatMap((root) => [
            <SpecialistCard
              key={root.specialistId}
              rec={root}
              depth={0}
              stepsLoaded={loadedStepsIds.has(root.specialistId) || root.steps.length > 0}
              onLoadSteps={() => handleLoadSteps(root.specialistId)}
            />,
            ...renderTree(items, root.specialistId, 1, loadedStepsIds, handleLoadSteps),
          ])
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
