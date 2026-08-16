'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ComposedChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  CartesianGrid,
} from 'recharts';
import {
  MessageSquare,
  ArrowUpFromLine,
  ArrowDownToLine,
  Users,
  Zap,
  CheckCircle2,
  RefreshCw,
  Bot,
  Cpu,
  DollarSign,
  TrendingUp,
  CalendarDays,
  Wallet,
  Download,
  Copy,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmailStatusCard } from '../_components/EmailStatusCard';
import { EmbedStatusCard } from '../_components/EmbedStatusCard';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MetricsData {
  period: number;
  hasPricing: boolean;
  cost: {
    totalUsd: number | null;
    yesterdayUsd: number | null;
    todayUsd: number | null;
    projectedTodayUsd: number | null;
  };
  summary: {
    totalMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalReasoningTokens: number;
    uniqueChats: number;
    jobsRun: number;
    jobSuccessRate: number | null;
  };
  byDay: {
    day: string;
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    nonCachedInputTokens: number;
    costUsd: number | null;
  }[];
  byRole: { role: string; count: number }[];
  byHour: { hour: number; count: number }[];
  byChatId: { chatId: string; count: number }[];
  jobStats: { status: string; count: number }[];
  byAgent: { agentId: string; count: number }[];
  byModel: { model: string; count: number; costUsd: number | null }[];
  heatmap: { date: string; count: number }[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = {
  user:       '#f59e0b',
  assistant:  '#38bdf8',
  system:     '#a78bfa',
  primary:    '#6366f1',
  success:    '#10b981',
  error:      '#f43f5e',
  warning:    '#f59e0b',
  muted:      '#94a3b8',
  pending:    '#64748b',
  // Token-composition series
  nonCached:  '#6366f1', // non-cached input (full price)
  cacheRead:  '#14b8a6', // cached read (cheap)
  cacheWrite: '#f59e0b', // cache creation (premium)
  output:     '#38bdf8',
  cost:       '#22c55e',
};

const AGENT_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#f97316', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
];

const MODEL_COLORS = [
  '#38bdf8', '#22d3ee', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
];

const JOB_COLORS: Record<string, string> = {
  completed: COLORS.success,
  failed:    COLORS.error,
  timed_out: COLORS.warning,
  pending:   COLORS.pending,
  running:   COLORS.muted,
};

const HEATMAP_CLASSES = [
  'bg-muted/60',
  'bg-indigo-200 dark:bg-indigo-900',
  'bg-indigo-400 dark:bg-indigo-700',
  'bg-indigo-600 dark:bg-indigo-500',
  'bg-indigo-800 dark:bg-indigo-300',
];

const TOOLTIP_STYLE = {
  background: 'oklch(0.205 0 0)',
  border: '1px solid oklch(1 0 0 / 15%)',
  borderRadius: 6,
  fontSize: 11,
  color: 'oklch(0.985 0 0)',
  boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
};

// Custom tooltip component — used for Pie charts where contentStyle is ignored.
function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color?: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_STYLE} className="px-2 py-1.5">
      {label && <div className="mb-1 text-[10px] font-medium" style={{ color: 'oklch(0.708 0 0)' }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'oklch(0.985 0 0)' }}>
          {p.color && <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />}
          <span>{p.name}: <strong>{p.value}</strong></span>
        </div>
      ))}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** USD, adaptive precision — sub-cent amounts still read as non-zero. */
function fmtUSD(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${fmtK(n)}`;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtHour(h: number): string {
  if (h === 0)  return '12a';
  if (h < 12)   return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

/** Build a full calendar-aligned heatmap grid (GitHub-style) */
function buildHeatmapGrid(heatmap: { date: string; count: number }[]): {
  weeks: { days: { date: string; count: number; intensity: number }[] }[];
  months: { label: string; col: number }[];
} {
  const countMap = new Map(heatmap.map((h) => [h.date, h.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Start 364 days ago, aligned to Sunday (day 0)
  const start = new Date(today);
  start.setDate(start.getDate() - 364 - today.getDay());

  const weeks: { days: { date: string; count: number; intensity: number }[] }[] = [];
  const monthPositions: { label: string; col: number }[] = [];
  let lastMonth = -1;

  const cursor = new Date(start);

  while (cursor <= today) {
    const weekStartDate = new Date(cursor);
    const m = weekStartDate.getMonth();

    // Track month changes at week boundaries
    if (m !== lastMonth) {
      lastMonth = m;
      monthPositions.push({
        label: weekStartDate.toLocaleString('default', { month: 'short' }),
        col: weeks.length,
      });
    }

    const week: { date: string; count: number; intensity: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const count = countMap.get(dateStr) ?? 0;
      const isFuture = cursor > today;

      let intensity = 0;
      if (!isFuture && count > 0) {
        if (count <= 2)      intensity = 1;
        else if (count <= 5) intensity = 2;
        else if (count <= 10) intensity = 3;
        else                  intensity = 4;
      }

      week.push({
        date: isFuture ? '' : dateStr,
        count,
        intensity: isFuture ? -1 : intensity,
      });

      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push({ days: week });
  }

  return { weeks, months: monthPositions };
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded-xl ${className ?? ''}`} />;
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <Skeleton className="h-28" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="lg:col-span-2 h-56" />
        <Skeleton className="h-56" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent?: string;
}

function KpiCard({ icon, label, value, sub, accent }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className={accent ?? 'text-muted-foreground'}>{icon}</span>
        <span className="text-xs font-medium truncate">{label}</span>
      </div>
      <div className="text-xl sm:text-2xl font-bold tabular-nums tracking-tight leading-none">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

// ── Chart card wrapper ─────────────────────────────────────────────────────────

function ChartCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card p-4 flex flex-col gap-3 ${className ?? ''}`}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {/* No blanket overflow wrapper: Recharts ResponsiveContainer fits width
          exactly and any wrapper here produced a phantom 1px scrollbar from
          subpixel rounding. Widgets that genuinely overflow (heatmap) scroll
          via their own inner wrapper. */}
      {children}
    </div>
  );
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

// Cell size + gap for heatmap (must match CSS)
const CELL = 12; // px  (w-3 / h-3)
const GAP  = 3;  // px  (gap-[3px])
const CELL_STRIDE = CELL + GAP; // 15 px per column

function ActivityHeatmap({ heatmap }: { heatmap: { date: string; count: number }[] }) {
  const { weeks, months } = buildHeatmapGrid(heatmap);
  // Only show Mon / Wed / Fri labels (indices 1, 3, 5)
  const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const LABEL_W = 28; // px — width of day-label column

  const gridW = weeks.length * CELL_STRIDE - GAP; // total grid width in px

  return (
    <ChartCard title="Activity — last 52 weeks">
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col min-w-max" style={{ gap: GAP }}>

          {/* Month labels — positioned absolutely over the grid */}
          <div style={{ marginLeft: LABEL_W, width: gridW, position: 'relative', height: 14 }}>
            {months.map((m) => (
              <span
                key={`${m.label}-${m.col}`}
                className="absolute text-[9px] text-muted-foreground leading-none"
                style={{ left: m.col * CELL_STRIDE }}
              >
                {m.label}
              </span>
            ))}
          </div>

          {/* Day rows */}
          <div className="flex" style={{ gap: GAP }}>
            {/* Day-of-week labels */}
            <div className="flex flex-col shrink-0" style={{ gap: GAP, width: LABEL_W }}>
              {DAY_LABELS.map((d, i) => (
                <div
                  key={i}
                  className="text-[9px] text-muted-foreground text-right pr-1 leading-none"
                  style={{ height: CELL, lineHeight: `${CELL}px` }}
                >
                  {d}
                </div>
              ))}
            </div>

            {/* Week columns */}
            <div className="flex" style={{ gap: GAP }}>
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
                  {week.days.map((day, di) => (
                    <div
                      key={di}
                      className={[
                        'rounded-sm shrink-0',
                        day.intensity === -1 ? 'opacity-0' : HEATMAP_CLASSES[day.intensity],
                      ].join(' ')}
                      style={{ width: CELL, height: CELL }}
                      title={day.date ? `${day.date} · ${day.count} message${day.count !== 1 ? 's' : ''}` : ''}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center mt-1" style={{ gap: GAP, marginLeft: LABEL_W }}>
            <span className="text-[9px] text-muted-foreground mr-0.5">Less</span>
            {HEATMAP_CLASSES.map((cls, i) => (
              <div key={i} className={`rounded-sm shrink-0 ${cls}`} style={{ width: CELL, height: CELL }} />
            ))}
            <span className="text-[9px] text-muted-foreground ml-0.5">More</span>
          </div>

        </div>
      </div>
    </ChartCard>
  );
}

// ── Small Pie with Label ───────────────────────────────────────────────────────

function SmallPieChart({
  data,
  dataKey = 'count',
  nameKey = 'name',
  colors,
  centerLabel,
  centerValue,
}: {
  data: { name: string; count: number }[];
  dataKey?: string;
  nameKey?: string;
  colors: string[];
  centerLabel: string;
  centerValue: string | number;
}) {
  const total = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="relative" style={{ height: 192 }}>
      <ResponsiveContainer width="100%" height={192}>
        <PieChart>
          <Pie
            data={data}
            dataKey={dataKey}
            nameKey={nameKey}
            cx="50%"
            cy="50%"
            innerRadius={48}
            outerRadius={68}
            paddingAngle={2}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Legend
            iconSize={8}
            wrapperStyle={{ fontSize: 10 }}
            formatter={(value) => <span className="text-foreground capitalize text-[10px]">{value}</span>}
          />
          <Tooltip content={<ChartTooltip />} wrapperStyle={{ zIndex: 50 }} />
        </PieChart>
      </ResponsiveContainer>
      {/* Center stat */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingBottom: '20px' }}>
        <div className="text-center">
          <div className="text-lg font-bold tabular-nums leading-none">{centerValue}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">{centerLabel}</div>
        </div>
      </div>
    </div>
  );
}

// ── Price-seed dialog ───────────────────────────────────────────────────────
// Fetches current per-model rates from OpenRouter's public API and shows a
// ready-to-paste YAML block for config.yaml (llm.pricing). We never write the
// config file for the user — it stays hand-editable, consistent with the rest
// of the config workflow.

function PriceSeedDialog({ open, onOpenChange, models }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  models: string[];
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ yaml: string; matched: string[]; unmatched: string[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchPrices = useCallback(async () => {
    setLoading(true);
    setErr('');
    setResult(null);
    try {
      const qs = models.length ? `?models=${encodeURIComponent(models.join(','))}` : '';
      const res = await fetch(`/api/metrics/pricing${qs}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Request failed');
      setResult({ yaml: body.yaml, matched: body.matched ?? [], unmatched: body.unmatched ?? [] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to fetch prices');
    } finally {
      setLoading(false);
    }
  }, [models]);

  // Fetch on open.
  useEffect(() => {
    if (open) void fetchPrices();
  }, [open, fetchPrices]);

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Seed pricing from OpenRouter</DialogTitle>
          <DialogDescription>
            Current rates for the models in use, fetched from OpenRouter&apos;s public API (USD per 1M tokens).
            Paste this into <code className="text-xs">config.yaml</code> under <code className="text-xs">llm.pricing</code>, then edit as needed. Config hot-reloads.
          </DialogDescription>
        </DialogHeader>

        {loading && <div className="py-8 text-center text-sm text-muted-foreground">Fetching prices…</div>}
        {err && <div className="py-4 text-sm text-destructive">{err}</div>}

        {result && (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">{result.yaml}</pre>
              <Button
                variant="outline"
                size="sm"
                onClick={copy}
                className="absolute top-2 right-2 gap-1.5"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {result.unmatched.length > 0 && (
              <p className="text-xs text-muted-foreground">
                No OpenRouter match for: <span className="text-foreground">{result.unmatched.join(', ')}</span>. Add these manually.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={fetchPrices} disabled={loading} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

export default function MetricsPage() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [chatNames, setChatNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>(30);
  // Token graphs can display raw tokens or estimated cost (only when a rate
  // card is configured — see llm.pricing in config.yaml).
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens');
  const [seedOpen, setSeedOpen] = useState(false);

  const loadData = useCallback(async (p: Period) => {
    setLoading(true);
    setError('');
    try {
      const [metricsRes, chatsRes] = await Promise.all([
        fetch(`/api/metrics?period=${p}`),
        fetch('/api/chats'),
      ]);
      const metrics = await metricsRes.json() as MetricsData;
      const chats = await chatsRes.json() as { chatId: string; name: string }[];
      setData(metrics);
      setChatNames(new Map(chats.map((c) => [c.chatId, c.name])));
    } catch {
      setError('Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(period); }, [period, loadData]);

  const handlePeriod = (p: Period) => { setPeriod(p); };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm">{error}</div>
    );
  }

  const hasTokens = (data?.summary.totalInputTokens ?? 0) > 0;
  const hasJobs   = (data?.summary.jobsRun ?? 0) > 0;
  const hasPricing = data?.hasPricing ?? false;
  const showCost = hasPricing && metric === 'cost';
  const { summary } = data ?? { summary: { totalMessages: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalReasoningTokens: 0, uniqueChats: 0, jobsRun: 0, jobSuccessRate: null } };
  const cost = data?.cost ?? { totalUsd: null, yesterdayUsd: null, todayUsd: null, projectedTodayUsd: null };
  const cacheHitPct = pct(summary.totalCacheReadTokens, summary.totalInputTokens);

  // Fill missing hours so the X axis is always 0-23
  const hourData = loading ? [] : Array.from({ length: 24 }, (_, h) => {
    const found = data?.byHour.find((r) => r.hour === h);
    return { hour: h, count: found?.count ?? 0 };
  });

  // Channel labels
  const channelData = (data?.byChatId ?? []).map((r) => ({
    ...r,
    label: chatNames.get(r.chatId) ?? r.chatId,
  }));

  // Agent data for pie chart
  const agentData = (data?.byAgent ?? []).map((a) => ({
    name: a.agentId === 'default' ? 'orchestrator' : a.agentId,
    count: a.count,
  }));

  // Model data for pie chart
  const modelData = (data?.byModel ?? []).map((m) => ({
    name: m.model,
    count: m.count,
  }));

  return (
    <div className="flex flex-col gap-6 overflow-auto pb-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between shrink-0 flex-wrap gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Metrics</h1>
        <div className="flex items-center gap-2">
          {/* Tokens ↔ Cost display toggle — only meaningful with a rate card */}
          {hasPricing && (
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(['tokens', 'cost'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMetric(m)}
                  className={[
                    'px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                    metric === m
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-muted',
                  ].join(' ')}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSeedOpen(true)}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Prices</span>
          </Button>
          <div className="flex rounded-lg border border-border overflow-hidden">
            {PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => handlePeriod(p)}
                className={[
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  period === p
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted',
                ].join(' ')}
              >
                {p}d
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => loadData(period)}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Channel status (each renders only when its channel is enabled) */}
      <EmailStatusCard />
      <EmbedStatusCard />

      {loading ? <LoadingSkeleton /> : (
        <>
          {/* ── KPI Cards ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 shrink-0">
            <KpiCard
              icon={<MessageSquare className="h-4 w-4" />}
              label="Messages"
              value={fmtK(summary.totalMessages)}
              sub={`last ${period}d`}
              accent="text-indigo-500"
            />
            <KpiCard
              icon={<ArrowUpFromLine className="h-4 w-4" />}
              label="Tokens In"
              value={hasTokens ? fmtK(summary.totalInputTokens) : '—'}
              sub={hasTokens && summary.totalCacheReadTokens > 0 ? `${cacheHitPct}% cache hit` : 'prompt tokens'}
              accent="text-amber-500"
            />
            <KpiCard
              icon={<ArrowDownToLine className="h-4 w-4" />}
              label="Tokens Out"
              value={hasTokens ? fmtK(summary.totalOutputTokens) : '—'}
              sub="completion tokens"
              accent="text-sky-500"
            />
            <KpiCard
              icon={<Users className="h-4 w-4" />}
              label="Active Chats"
              value={String(summary.uniqueChats)}
              sub={`in last ${period}d`}
              accent="text-violet-500"
            />
            <KpiCard
              icon={<Zap className="h-4 w-4" />}
              label="Jobs Run"
              value={fmtK(summary.jobsRun)}
              sub={`last ${period}d`}
              accent="text-emerald-500"
            />
            <KpiCard
              icon={<CheckCircle2 className="h-4 w-4" />}
              label="Success Rate"
              value={summary.jobSuccessRate !== null ? `${summary.jobSuccessRate}%` : '—'}
              sub={`last ${period}d`}
              accent={summary.jobSuccessRate !== null && summary.jobSuccessRate >= 80 ? 'text-emerald-500' : 'text-rose-500'}
            />
          </div>

          {/* ── Cost tiles (only when a rate card is configured) ───────────────── */}
          {hasPricing && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
              <KpiCard
                icon={<DollarSign className="h-4 w-4" />}
                label="Cost Today"
                value={fmtUSD(cost.todayUsd)}
                sub="so far (UTC)"
                accent="text-emerald-500"
              />
              <KpiCard
                icon={<TrendingUp className="h-4 w-4" />}
                label="Projected Today"
                value={fmtUSD(cost.projectedTodayUsd)}
                sub="at current pace"
                accent="text-sky-500"
              />
              <KpiCard
                icon={<CalendarDays className="h-4 w-4" />}
                label="Cost Yesterday"
                value={fmtUSD(cost.yesterdayUsd)}
                sub="full UTC day"
                accent="text-violet-500"
              />
              <KpiCard
                icon={<Wallet className="h-4 w-4" />}
                label="Total Cost"
                value={fmtUSD(cost.totalUsd)}
                sub="all-time, priced models"
                accent="text-amber-500"
              />
            </div>
          )}

          {/* ── Activity Heatmap ─────────────────────────────────────────────── */}
          <ActivityHeatmap heatmap={data?.heatmap ?? []} />

          {/* ── Trend + Agent/Model Distribution ─────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Messages + Tokens/Cost trend */}
            <ChartCard title={`Messages${hasTokens ? (showCost ? ' & Cost' : ' & Tokens') : ''} / Day (last ${period}d)`} className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={208}>
                  <ComposedChart data={data?.byDay.map((d) => ({ ...d, day: fmtDay(d.day) })) ?? []} margin={{ top: 4, right: hasTokens ? 40 : 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="left" tick={{ fontSize: 10 }} allowDecimals={false} tickLine={false} axisLine={false} />
                    {hasTokens && (
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={showCost ? fmtUSD : fmtK} width={showCost ? 48 : undefined} />
                    )}
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, name) => (name === 'cost' ? fmtUSD(Number(v)) : v)} />
                    <Area
                      yAxisId="left"
                      type="monotone"
                      dataKey="messages"
                      fill={COLORS.primary}
                      stroke={COLORS.primary}
                      fillOpacity={0.15}
                      strokeWidth={2}
                      dot={false}
                    />
                    {hasTokens && (
                      <Area
                        yAxisId="right"
                        type="monotone"
                        dataKey={showCost ? 'costUsd' : 'outputTokens'}
                        fill={showCost ? COLORS.cost : COLORS.assistant}
                        stroke={showCost ? COLORS.cost : COLORS.assistant}
                        fillOpacity={showCost ? 0.15 : 0.1}
                        strokeWidth={1.5}
                        dot={false}
                        name={showCost ? 'cost' : 'tokens out'}
                        connectNulls
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
            </ChartCard>

            {/* Agent Usage Distribution */}
            <ChartCard
              title="Agent Usage"
              className="flex flex-col"
            >
              <div className="flex items-center gap-2 mb-1">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Which agents respond</span>
              </div>
              {agentData.length > 0 ? (
                <SmallPieChart
                  data={agentData}
                  nameKey="name"
                  dataKey="count"
                  colors={AGENT_COLORS}
                  centerLabel="agents"
                  centerValue={agentData.length}
                />
              ) : (
                <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">
                  No agent data yet
                </div>
              )}
            </ChartCard>
          </div>

          {/* ── Model Distribution ───────────────────────────────────────────── */}
          {modelData.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ChartCard title="AI Model Distribution">
                <div className="flex items-center gap-2 mb-1">
                  <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Which AI models are used</span>
                </div>
                <SmallPieChart
                  data={modelData}
                  nameKey="name"
                  dataKey="count"
                  colors={MODEL_COLORS}
                  centerLabel="models"
                  centerValue={modelData.length}
                />
              </ChartCard>

              {/* Hourly activity */}
              <ChartCard title="Activity by Hour of Day">
                <ResponsiveContainer width="100%" height={176}>
                  <BarChart data={hourData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={fmtHour} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={2} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => `${fmtHour(v as number)} – ${fmtHour((v as number) + 1)}`} />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]} fill={COLORS.primary} fillOpacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          )}

          {/* ── Hourly + Channels (when no model data) ─────────────────────────── */}
          {modelData.length === 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Hourly activity */}
              <ChartCard title="Activity by Hour of Day">
                <ResponsiveContainer width="100%" height={176}>
                  <BarChart data={hourData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={fmtHour} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={2} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => `${fmtHour(v as number)} – ${fmtHour((v as number) + 1)}`} />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]} fill={COLORS.primary} fillOpacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* Top channels */}
              <ChartCard title="Top Channels">
                <ResponsiveContainer width="100%" height={176}>
                  <BarChart
                    data={channelData}
                    layout="vertical"
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} tickLine={false} axisLine={false} />
                    <YAxis
                      type="category"
                      dataKey="label"
                      tick={{ fontSize: 10 }}
                      width={72}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: string) => v.length > 10 ? `${v.slice(0, 9)}…` : v}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value, _name, props) => [value, props.payload?.chatId ?? '']}
                    />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]} fill={COLORS.primary} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          )}

          {/* ── Jobs + Token composition ──────────────────────────────────────── */}
          {(hasJobs || hasTokens) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Job outcomes */}
              {hasJobs && (
                <ChartCard title="Job Outcomes">
                  <div className="relative" style={{ height: 176 }}>
                    <ResponsiveContainer width="100%" height={176}>
                      <PieChart>
                        <Pie
                          data={data?.jobStats ?? []}
                          dataKey="count"
                          nameKey="status"
                          cx="50%"
                          cy="50%"
                          innerRadius={44}
                          outerRadius={64}
                          paddingAngle={3}
                        >
                          {(data?.jobStats ?? []).map((entry) => (
                            <Cell key={entry.status} fill={JOB_COLORS[entry.status] ?? COLORS.muted} />
                          ))}
                        </Pie>
                        <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} formatter={(value) => <span className="text-foreground capitalize">{value}</span>} />
                        <Tooltip content={<ChartTooltip />} wrapperStyle={{ zIndex: 50 }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingBottom: '24px' }}>
                      <div className="text-center">
                        <div className="text-lg font-bold tabular-nums leading-none">{fmtK(summary.jobsRun)}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">jobs</div>
                      </div>
                    </div>
                  </div>
                </ChartCard>
              )}

              {/* Token composition (cache-aware) / Cost per day */}
              {hasTokens && (
                <ChartCard title={showCost ? 'Cost / Day' : 'Token Composition / Day'}>
                  <ResponsiveContainer width="100%" height={176}>
                    <BarChart
                      data={(data?.byDay ?? []).slice(-14).map((d) => ({ ...d, day: fmtDay(d.day) }))}
                      margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={showCost ? fmtUSD : fmtK} tickLine={false} axisLine={false} width={showCost ? 48 : undefined} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => (showCost ? fmtUSD(Number(v)) : fmtK(Number(v)))} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                      {showCost ? (
                        <Bar dataKey="costUsd" name="cost" fill={COLORS.cost} fillOpacity={0.85} radius={[3, 3, 0, 0]} />
                      ) : (
                        <>
                          <Bar dataKey="nonCachedInputTokens" name="input" stackId="t" fill={COLORS.nonCached} fillOpacity={0.85} />
                          <Bar dataKey="cacheReadTokens" name="cache read" stackId="t" fill={COLORS.cacheRead} fillOpacity={0.85} />
                          <Bar dataKey="cacheWriteTokens" name="cache write" stackId="t" fill={COLORS.cacheWrite} fillOpacity={0.85} />
                          <Bar dataKey="outputTokens" name="output" stackId="t" fill={COLORS.output} fillOpacity={0.85} radius={[3, 3, 0, 0]} />
                        </>
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              )}
            </div>
          )}
        </>
      )}

      <PriceSeedDialog
        open={seedOpen}
        onOpenChange={setSeedOpen}
        models={(data?.byModel ?? []).map((m) => m.model).filter((m) => m && m !== 'unknown')}
      />
    </div>
  );
}
