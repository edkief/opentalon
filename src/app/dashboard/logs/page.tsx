'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ScrollText, Pause, Play, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LogEvent, LogLevel } from '@/lib/agent/log-bus';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CLIENT_LOGS = 5000;

const LEVEL_STYLES: Record<LogLevel | 'all', string> = {
  all:   'bg-muted text-muted-foreground',
  log:   'bg-muted text-muted-foreground',
  info:  'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  warn:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  error: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  debug: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  log:   'LOG',
  info:  'INFO',
  warn:  'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

const ALL_LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LevelBadge({ level }: { level: LogLevel }) {
  return (
    <span
      className={[
        'shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide w-12 justify-center',
        LEVEL_STYLES[level],
      ].join(' ')}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

function LogRow({ event }: { event: LogEvent }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1 font-mono text-xs hover:bg-muted/40 border-b border-border/30 last:border-0">
      <span className="text-muted-foreground shrink-0 w-28 tabular-nums select-none">
        {fmtTs(event.ts)}
      </span>
      <LevelBadge level={event.level} />
      <span
        className="text-indigo-600 dark:text-indigo-400 shrink-0 max-w-[120px] truncate"
        title={event.component}
      >
        [{event.component}]
      </span>
      <span className="text-foreground whitespace-pre-wrap break-all flex-1 leading-relaxed">
        {event.message}
      </span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [componentFilter, setComponentFilter] = useState<string>('all');
  const [textFilter, setTextFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  const pausedRef = useRef(false);
  const pendingRef = useRef<LogEvent[]>([]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Keep pausedRef in sync without recreating the SSE listener
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // SSE connection — stable for page lifetime
  useEffect(() => {
    const es = new EventSource('/api/logs/system');

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as LogEvent;
        if (pausedRef.current) {
          pendingRef.current.push(event);
        } else {
          setLogs((prev) => [...prev.slice(-(MAX_CLIENT_LOGS - 1)), event]);
        }
      } catch {
        // ignore malformed or heartbeat lines
      }
    };

    return () => es.close();
  }, []); // empty deps — one stable connection per page mount

  // Drain pending buffer when unpausing
  const handleResume = () => {
    setPaused(false);
    if (pendingRef.current.length > 0) {
      const pending = pendingRef.current.splice(0);
      setLogs((prev) => [...prev, ...pending].slice(-MAX_CLIENT_LOGS));
    }
  };

  const handleClear = () => {
    setLogs([]);
    pendingRef.current = [];
  };

  // ── Derived state ───────────────────────────────────────────────────────────

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of logs) {
      counts[e.level] = (counts[e.level] ?? 0) + 1;
    }
    return counts;
  }, [logs]);

  const components = useMemo(() => {
    const seen = new Set(logs.map((e) => e.component));
    return ['all', ...Array.from(seen).sort()];
  }, [logs]);

  const filtered = useMemo(() => {
    return logs.filter((e) => {
      if (levelFilter !== 'all' && e.level !== levelFilter) return false;
      if (componentFilter !== 'all' && e.component !== componentFilter) return false;
      if (textFilter && !e.raw.toLowerCase().includes(textFilter.toLowerCase())) return false;
      return true;
    });
  }, [logs, levelFilter, componentFilter, textFilter]);

  return (
    <div className="flex flex-col h-full gap-3 p-4 min-h-0">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">System Logs</h1>
          <span
            className={[
              'inline-block h-2 w-2 rounded-full',
              connected ? 'bg-green-500' : 'bg-yellow-500',
            ].join(' ')}
            title={connected ? 'Connected' : 'Disconnected'}
          />
          {paused && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              Paused ({pendingRef.current.length} buffered)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {paused ? (
            <Button size="sm" variant="outline" onClick={handleResume}>
              <Play className="h-3.5 w-3.5 mr-1" />
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setPaused(true)}>
              <Pause className="h-3.5 w-3.5 mr-1" />
              Pause
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
          >
            <RefreshCw className={['h-3.5 w-3.5', autoScroll ? 'text-green-500' : 'text-muted-foreground'].join(' ')} />
          </Button>
          <Button size="sm" variant="outline" onClick={handleClear}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            Clear
          </Button>
        </div>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {/* Level filter buttons */}
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <button
            onClick={() => setLevelFilter('all')}
            className={[
              'rounded px-2 py-0.5 text-xs font-medium transition-colors',
              levelFilter === 'all'
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            ALL{' '}
            <span className="opacity-60">{logs.length}</span>
          </button>
          {ALL_LEVELS.map((lvl) => (
            <button
              key={lvl}
              onClick={() => setLevelFilter(lvl)}
              className={[
                'rounded px-2 py-0.5 text-xs font-medium transition-colors',
                levelFilter === lvl
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {LEVEL_LABEL[lvl]}{' '}
              <span className="opacity-60">{levelCounts[lvl] ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Component filter */}
        <select
          value={componentFilter}
          onChange={(e) => setComponentFilter(e.target.value)}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {components.map((c) => (
            <option key={c} value={c}>
              {c === 'all' ? 'All components' : `[${c}]`}
            </option>
          ))}
        </select>

        {/* Text search */}
        <input
          type="text"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="Search logs..."
          className="h-7 flex-1 min-w-[160px] rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />

        <span className="text-xs text-muted-foreground tabular-nums">
          {filtered.length.toLocaleString()} / {logs.length.toLocaleString()} entries
        </span>
      </div>

      {/* ── Log stream ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 rounded-md border border-border bg-background overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {logs.length === 0
              ? 'Waiting for log output…'
              : 'No entries match current filters.'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={filtered}
            followOutput={autoScroll && !paused ? 'smooth' : false}
            itemContent={(_, event) => <LogRow event={event} />}
            style={{ height: '100%' }}
            className="scrollbar-thin"
          />
        )}
      </div>
    </div>
  );
}
