'use client';

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';

interface EmailStatus {
  enabled: boolean;
  connected: boolean;
  mailbox: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  backoffMs: number;
}

/**
 * Compact email-channel connectivity card. Polls /api/services/status (which
 * embeds getEmailStatus()) every 15s. Renders nothing when email is disabled so
 * it stays out of the way for Telegram/web-only deployments.
 */
export function EmailStatusCard() {
  const [status, setStatus] = useState<EmailStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/services/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { email?: EmailStatus };
        if (!cancelled && data.email) setStatus(data.email);
      } catch {
        /* transient — keep last known status */
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!status?.enabled) return null;

  const { connected, mailbox, lastSyncAt, lastError, backoffMs } = status;
  const dotColor = connected ? 'bg-emerald-500' : backoffMs > 0 ? 'bg-amber-500' : 'bg-red-500';
  const label = connected ? 'Connected' : backoffMs > 0 ? `Reconnecting (${Math.round(backoffMs / 1000)}s)` : 'Disconnected';

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2 shrink-0">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Mail className="h-4 w-4" />
        <span className="text-xs font-medium">Email channel</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          <span className="tabular-nums">{label}</span>
        </span>
      </div>
      <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        <span>Mailbox: <span className="text-foreground">{mailbox ?? '—'}</span></span>
        <span>
          Last sync:{' '}
          <span className="text-foreground">
            {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : '—'}
          </span>
        </span>
      </div>
      {lastError && (
        <div className="text-xs text-red-500 truncate" title={lastError}>
          Last error: {lastError}
        </div>
      )}
    </div>
  );
}
