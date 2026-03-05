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

  useEffect(() => {
    fetch('/api/agent-memory')
      .then((r) => r.json())
      .then((d: { content: string }) => setContent(d.content))
      .finally(() => setLoading(false));
  }, []);

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
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Core Memory</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Agent-editable scratchpad — always included in the system prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        <div className="flex-1 overflow-auto" data-color-mode={isDark ? 'dark' : 'light'}>
          <MDEditor
            value={content}
            onChange={(v) => setContent(v ?? '')}
            height="100%"
            preview="edit"
          />
        </div>
      )}
    </div>
  );
}
