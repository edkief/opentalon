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
} from 'lucide-react';
import { Button } from '@/components/ui/button';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MetricsData {
  period: number;
  summary: {
    totalMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    uniqueChats: number;
    jobsRun: number;
    jobSuccessRate: number | null;
  };
  byDay: { day: string; messages: number; inputTokens: number; outputTokens: number }[];
  byRole: { role: string; count: number }[];
  byHour: { hour: number; count: number }[];
  byChatId: { chatId: string; count: number }[];
  jobStats: { status: string; count: number }[];
  heatmap: { date: string; count: number }[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = {
  user:      '#f59e0b',
  assistant: '#38bdf8',
  system:    '#a78bfa',
  primary:   '#6366f1',
  success:   '#10b981',
  error:     '#f43f5e',
  warning:   '#f59e0b',
  muted:     '#94a3b8',
  pending:   '#64748b',
};

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
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 11,
  color: 'var(--foreground)',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
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

/** Build a full 365-day grid starting from today going back, aligned to week boundaries */
function buildHeatmapGrid(heatmap: { date: string; count: number }[]): {
  weeks: { days: { date: string; count: number; intensity: number }[] }[];
  months: { label: string; col: number }[];
} {
  const countMap = new Map(heatmap.map((h) => [h.date, h.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find the Sunday on or before (today - 364 days)
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday

  const weeks: { days: { date: string; count: number; intensity: number }[] }[] = [];
  const months: { label: string; col: number }[] = [];
  let lastMonth = -1;

  const cursor = new Date(start);
  let col = 0;
  while (cursor <= today) {
    const week: { date: string; count: number; intensity: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const count = countMap.get(dateStr) ?? 0;
      const isFuture = cursor > today;
      let intensity = 0;
      if (!isFuture && count > 0) {
        if (count <= 2)  intensity = 1;
        else if (count <= 5)  intensity = 2;
        else if (count <= 10) intensity = 3;
        else intensity = 4;
      }
      week.push({ date: isFuture ? '' : dateStr, count, intensity: isFuture ? -1 : intensity });

      // Track month labels (first week of each month)
      if (!isFuture && d === 0) {
        const m = cursor.getMonth();
        if (m !== lastMonth) {
          lastMonth = m;
          months.push({ label: cursor.toLocaleString('default', { month: 'short' }), col });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push({ days: week });
    col++;
  }
  return { weeks, months };
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
      <div className="text-2xl font-bold tabular-nums tracking-tight leading-none">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

// ── Chart card wrapper ─────────────────────────────────────────────────────────

function ChartCard({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card p-4 flex flex-col gap-3 ${className ?? ''}`}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

function ActivityHeatmap({ heatmap }: { heatmap: { date: string; count: number }[] }) {
  const { weeks, months } = buildHeatmapGrid(heatmap);
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <ChartCard title="Activity — last 52 weeks">
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col gap-1 min-w-max">
          {/* Month labels */}
          <div className="flex ml-8 gap-[1px]">
            {weeks.map((_, wi) => {
              const month = months.find((m) => m.col === wi);
              return (
                <div key={wi} className="w-3 text-[9px] text-muted-foreground shrink-0">
                  {month?.label ?? ''}
                </div>
              );
            })}
          </div>

          {/* Day rows */}
          <div className="flex gap-1">
            {/* Day labels */}
            <div className="flex flex-col gap-[1px] justify-around mr-1">
              {DAY_LABELS.map((d, i) => (
                <div key={d} className={`text-[9px] text-muted-foreground w-6 text-right ${i % 2 === 0 ? 'invisible' : ''}`}>
                  {d}
                </div>
              ))}
            </div>
            {/* Week columns */}
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[1px]">
                {week.days.map((day, di) => (
                  <div
                    key={di}
                    className={[
                      'w-3 h-3 rounded-sm',
                      day.intensity === -1 ? 'opacity-0' : HEATMAP_CLASSES[day.intensity],
                    ].join(' ')}
                    title={day.date ? `${day.date} · ${day.count} message${day.count !== 1 ? 's' : ''}` : ''}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-1 mt-1 ml-8">
            <span className="text-[9px] text-muted-foreground mr-0.5">Less</span>
            {HEATMAP_CLASSES.map((cls, i) => (
              <div key={i} className={`w-3 h-3 rounded-sm ${cls}`} />
            ))}
            <span className="text-[9px] text-muted-foreground ml-0.5">More</span>
          </div>
        </div>
      </div>
    </ChartCard>
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
  const { summary } = data ?? { summary: { totalMessages: 0, totalInputTokens: 0, totalOutputTokens: 0, uniqueChats: 0, jobsRun: 0, jobSuccessRate: null } };

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

  return (
    <div className="flex flex-col gap-6 overflow-auto pb-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between shrink-0 flex-wrap gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Metrics</h1>
        <div className="flex items-center gap-2">
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
              sub="prompt tokens"
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

          {/* ── Activity Heatmap ─────────────────────────────────────────────── */}
          <ActivityHeatmap heatmap={data?.heatmap ?? []} />

          {/* ── Trend + Role ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Messages + Tokens trend */}
            <ChartCard title={`Messages${hasTokens ? ' & Tokens' : ''} / Day (last ${period}d)`} className="lg:col-span-2">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data?.byDay.map((d) => ({ ...d, day: fmtDay(d.day) })) ?? []} margin={{ top: 4, right: hasTokens ? 40 : 8, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="left" tick={{ fontSize: 10 }} allowDecimals={false} tickLine={false} axisLine={false} />
                    {hasTokens && (
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={fmtK} />
                    )}
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--foreground)' }} />
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
                        dataKey="outputTokens"
                        fill={COLORS.assistant}
                        stroke={COLORS.assistant}
                        fillOpacity={0.1}
                        strokeWidth={1.5}
                        dot={false}
                        name="tokens out"
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            {/* Role donut */}
            <ChartCard title="Message Distribution">
              <div className="h-52 relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data?.byRole ?? []}
                      dataKey="count"
                      nameKey="role"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={72}
                      paddingAngle={3}
                    >
                      {(data?.byRole ?? []).map((entry) => (
                        <Cell key={entry.role} fill={COLORS[entry.role as keyof typeof COLORS] ?? COLORS.muted} />
                      ))}
                    </Pie>
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} formatter={(value) => <span className="text-foreground capitalize">{value}</span>} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center stat */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingBottom: '24px' }}>
                  <div className="text-center">
                    <div className="text-lg font-bold tabular-nums leading-none">{fmtK(summary.totalMessages)}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">total</div>
                  </div>
                </div>
              </div>
            </ChartCard>
          </div>

          {/* ── Hourly + Channels ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Hourly activity */}
            <ChartCard title="Activity by Hour of Day">
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={fmtHour} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval={2} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => `${fmtHour(v as number)} – ${fmtHour((v as number) + 1)}`} />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]} fill={COLORS.primary} fillOpacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>

            {/* Top channels */}
            <ChartCard title="Top Channels">
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
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
              </div>
            </ChartCard>
          </div>

          {/* ── Jobs + Token composition ──────────────────────────────────────── */}
          {(hasJobs || hasTokens) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Job outcomes */}
              {hasJobs && (
                <ChartCard title="Job Outcomes">
                  <div className="h-44 relative">
                    <ResponsiveContainer width="100%" height="100%">
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
                        <Tooltip contentStyle={TOOLTIP_STYLE} />
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

              {/* Token composition stacked bar */}
              {hasTokens && (
                <ChartCard title="Token Composition / Day">
                  <div className="h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={(data?.byDay ?? []).slice(-14).map((d) => ({ ...d, day: fmtDay(d.day) }))}
                        margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtK} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => fmtK(Number(v))} />
                        <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="inputTokens" name="tokens in" stackId="t" fill={COLORS.primary} fillOpacity={0.8} radius={[0, 0, 0, 0]} />
                        <Bar dataKey="outputTokens" name="tokens out" stackId="t" fill={COLORS.assistant} fillOpacity={0.8} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </ChartCard>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
