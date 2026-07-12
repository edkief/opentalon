'use client';

import { useEffect, useState } from 'react';
import { Mail, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface EmailStatus {
  enabled: boolean;
  connected: boolean;
  mailbox: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  backoffMs: number;
  lastUid: number;
  mailboxUidNext: number | null;
}

/**
 * Compact email-channel connectivity card. Polls /api/services/status (which
 * embeds getEmailStatus()) every 15s. Renders nothing when email is disabled so
 * it stays out of the way for Telegram/web-only deployments.
 */
export function EmailStatusCard() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [resyncOpen, setResyncOpen] = useState(false);
  const [resyncValue, setResyncValue] = useState('');
  const [resyncBusy, setResyncBusy] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/services/status', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { email?: EmailStatus };
      if (data.email) setStatus(data.email);
    } catch {
      /* transient — keep last known status */
    }
  };

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await load();
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!status?.enabled) return null;

  const { connected, mailbox, lastSyncAt, lastError, backoffMs, lastUid, mailboxUidNext } = status;
  const dotColor = connected ? 'bg-emerald-500' : backoffMs > 0 ? 'bg-amber-500' : 'bg-red-500';
  const label = connected ? 'Connected' : backoffMs > 0 ? `Reconnecting (${Math.round(backoffMs / 1000)}s)` : 'Disconnected';

  const highestKnownUid = mailboxUidNext != null ? mailboxUidNext - 1 : null;
  const parsedResync = Number(resyncValue);
  const resyncValid = resyncValue.trim() !== '' && Number.isInteger(parsedResync) && parsedResync >= 0;
  const rescanCount = resyncValid && highestKnownUid != null ? Math.max(0, highestKnownUid - parsedResync) : null;

  const syncNow = async () => {
    setSyncing(true);
    try {
      await fetch('/api/services/email/sync', { method: 'POST' });
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const openResync = () => {
    setResyncValue(String(lastUid));
    setResyncError(null);
    setResyncOpen(true);
  };

  const confirmResync = async () => {
    if (!resyncValid) return;
    setResyncBusy(true);
    setResyncError(null);
    try {
      const res = await fetch('/api/services/email/resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: parsedResync }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setResyncError(data.error ?? 'Resync failed.');
        return;
      }
      setResyncOpen(false);
      await load();
    } catch (err) {
      setResyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setResyncBusy(false);
    }
  };

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
        <span>Last processed message #: <span className="text-foreground">{lastUid}</span></span>
      </div>
      {lastError && (
        <div className="text-xs text-red-500 truncate" title={lastError}>
          Last error: {lastError}
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={syncNow} disabled={!connected || syncing}>
          <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
          Sync now
        </Button>
        <Button size="sm" variant="outline" onClick={openResync} disabled={!connected}>
          Change starting point
        </Button>
      </div>

      <Dialog open={resyncOpen} onOpenChange={setResyncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change starting point</DialogTitle>
            <DialogDescription>
              The agent tracks mail by message number to know what it has already read.
              Lowering this number makes it re-scan older mail; already-processed messages
              are recognized and skipped, so nothing gets replied to twice.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="text-xs text-muted-foreground">
              Current value: <span className="text-foreground font-medium tabular-nums">{lastUid}</span>
            </div>
            <Input
              type="number"
              min={0}
              step={1}
              value={resyncValue}
              onChange={(e) => setResyncValue(e.target.value)}
              placeholder="New starting message #"
            />
            {resyncValid && (
              <div className="text-xs text-amber-500">
                Confirming this operation will rescan up to {rescanCount} email{rescanCount === 1 ? '' : 's'}.
              </div>
            )}
            {!resyncValid && resyncValue.trim() !== '' && (
              <div className="text-xs text-red-500">Enter a whole number, 0 or greater.</div>
            )}
            {resyncError && <div className="text-xs text-red-500">{resyncError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResyncOpen(false)} disabled={resyncBusy}>
              Cancel
            </Button>
            <Button onClick={confirmResync} disabled={!resyncValid || resyncBusy}>
              {resyncBusy ? 'Applying…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
