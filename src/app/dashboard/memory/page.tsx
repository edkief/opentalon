'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });

type Status = 'idle' | 'saving' | 'saved' | 'error';

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
    </div>
  );
}
