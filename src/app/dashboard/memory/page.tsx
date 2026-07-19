'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

type Status = 'idle' | 'saving' | 'saved' | 'error';

type RecallPoint = {
  id: string;
  payload: {
    text?: string;
    category?: string;
    scope?: string;
    agent?: string;
    chat_id?: string;
    timestamp?: number;
  };
};

function RecallEntries() {
  const [points, setPoints] = useState<RecallPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch('/api/memory?limit=200')
      .then((r) => r.json())
      .then((d: { points?: RecallPoint[] }) => setPoints(d.points ?? []))
      .catch(() => setPoints([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' });
      if (res.ok) setPoints((prev) => prev.filter((p) => p.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recall Notes</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Episodic notes saved via memory_append store:&apos;recall&apos; — retrieved on demand, not always-on.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-4">Loading recall notes…</div>
      ) : points.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4">No recall notes stored yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {points.map((p) => (
            <li key={p.id} className="rounded border border-border p-3 flex gap-3 items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  {p.payload.category && (
                    <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {p.payload.category}
                    </span>
                  )}
                  {p.payload.scope && (
                    <span className="text-[10px] text-muted-foreground">{p.payload.scope}</span>
                  )}
                  {p.payload.agent && (
                    <span className="text-[10px] text-muted-foreground">@{p.payload.agent}</span>
                  )}
                  {p.payload.timestamp && (
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(p.payload.timestamp).toLocaleString()}
                    </span>
                  )}
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">{p.payload.text}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(p.id)}
                disabled={deleting === p.id}
                className="text-red-500 shrink-0"
              >
                {deleting === p.id ? '…' : 'Delete'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AgentMemoryPage() {
  const { isDark } = useTheme();
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [loading, setLoading] = useState(true);
  const [softLimit, setSoftLimit] = useState(1500);

  useEffect(() => {
    fetch('/api/agent-memory')
      .then((r) => r.json())
      .then((d: { content: string; stats?: { softLimitTokens: number } }) => {
        setContent(d.content);
        if (d.stats?.softLimitTokens) setSoftLimit(d.stats.softLimitTokens);
      })
      .finally(() => setLoading(false));
  }, []);

  // Live estimate (chars/token heuristic, matches the backend) so the budget
  // updates as you edit. Core Memory is injected into every request, so this
  // is always-on context cost (#21).
  const approxTokens = Math.ceil(content.length / 3.8);
  const overBudget = approxTokens > softLimit;

  const handleSave = async () => {
    setStatus('saving');
    try {
      const res = await fetch('/api/agent-memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setStatus(res.ok ? 'saved' : 'error');
    } catch {
      setStatus('error');
    }
    setTimeout(() => setStatus('idle'), 2000);
  };

  const busy = status !== 'idle';

  return (
    <div className="flex flex-col h-full gap-6 overflow-auto pb-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Core Memory</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Agent-editable scratchpad — always included in the system prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!loading && (
            <span
              className={`text-xs rounded px-2 py-1 ${
                overBudget
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              }`}
              title={
                overBudget
                  ? 'Core Memory is injected into every request. Move episodic/dated notes into RAG (retrieved on demand) and keep this for durable identity and standing rules.'
                  : 'Estimated always-on token cost of Core Memory (injected into every request).'
              }
            >
              ~{approxTokens.toLocaleString()} / {softLimit.toLocaleString()} tokens
              {overBudget ? ' ⚠️ over soft budget' : ''}
            </span>
          )}
          {status === 'saved' && <span className="text-sm text-green-500">Saved</span>}
          {status === 'error' && <span className="text-sm text-red-500">Failed</span>}
          <Button onClick={handleSave} disabled={busy || loading}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Loading memory…
        </div>
      ) : (
        <div className="min-h-[40vh] shrink-0" data-color-mode={isDark ? 'dark' : 'light'}>
          <MDEditor
            value={content}
            onChange={(v) => setContent(v ?? '')}
            height={400}
            preview="edit"
          />
        </div>
      )}

      <RecallEntries />
    </div>
  );
}
