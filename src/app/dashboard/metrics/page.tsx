'use client';

import { useEffect, useState } from 'react';
import {
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
} from 'recharts';

interface MetricsData {
  byDay: { day: string; count: number }[];
  byRole: { role: string; count: number }[];
  byChatId: { chatId: string; count: number }[];
}

const ROLE_COLORS: Record<string, string> = {
  user: '#f59e0b',
  assistant: '#38bdf8',
  system: '#a78bfa',
};

const CHAT_COLORS = ['#6366f1', '#10b981', '#f43f5e', '#f59e0b', '#38bdf8', '#a78bfa', '#84cc16', '#fb923c', '#e879f9', '#2dd4bf'];

function formatDay(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function MetricsPage() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/metrics')
      .then((r) => r.json())
      .then((d: MetricsData) => setData(d))
      .catch(() => setError('Failed to load metrics'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading metrics…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center text-red-500 text-sm">
        {error || 'No data'}
      </div>
    );
  }

  const dayData = data.byDay.map((d) => ({ ...d, day: formatDay(d.day) }));

  return (
    <div className="flex flex-col h-full gap-6 overflow-auto">
      <h1 className="text-lg font-semibold shrink-0">Metrics</h1>

      {/* ── Messages by day ───────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Messages / Day (last 30 days)</h2>
        <div className="h-52 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dayData} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}
                labelStyle={{ color: 'var(--foreground)' }}
              />
              <Bar dataKey="count" fill="#6366f1" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="flex gap-6 flex-wrap">
        {/* ── By role ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2 flex-1 min-w-[200px]">
          <h2 className="text-sm font-medium text-muted-foreground">By Role</h2>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data.byRole}
                  dataKey="count"
                  nameKey="role"
                  cx="50%"
                  cy="50%"
                  outerRadius={60}
                  label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {data.byRole.map((entry) => (
                    <Cell key={entry.role} fill={ROLE_COLORS[entry.role] ?? '#888'} />
                  ))}
                </Pie>
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* ── Top chat IDs ────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2 flex-1 min-w-[240px]">
          <h2 className="text-sm font-medium text-muted-foreground">Top Channels</h2>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.byChatId}
                layout="vertical"
                margin={{ top: 0, right: 8, left: 8, bottom: 0 }}
              >
                <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="chatId"
                  tick={{ fontSize: 10 }}
                  width={70}
                  tickFormatter={(v: string) => v.length > 9 ? `…${v.slice(-7)}` : v}
                />
                <Tooltip
                  contentStyle={{ fontSize: 11, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}
                />
                <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                  {data.byChatId.map((_, i) => (
                    <Cell key={i} fill={CHAT_COLORS[i % CHAT_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      {/* ── Summary numbers ──────────────────────────────────────────────── */}
      <section className="flex gap-4 flex-wrap shrink-0">
        {data.byRole.map((r) => (
          <div
            key={r.role}
            className="rounded-lg border border-border p-4 min-w-[120px] flex flex-col gap-1"
          >
            <span className="text-xs text-muted-foreground capitalize">{r.role} messages</span>
            <span className="text-2xl font-bold tabular-nums">{r.count}</span>
          </div>
        ))}
        <div className="rounded-lg border border-border p-4 min-w-[120px] flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Unique channels</span>
          <span className="text-2xl font-bold tabular-nums">{data.byChatId.length}</span>
        </div>
      </section>
    </div>
  );
}
