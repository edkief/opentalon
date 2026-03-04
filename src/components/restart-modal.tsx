'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface RunningJob {
  id: string;
  chatId: string;
  status: string;
  taskDescription: string;
  createdAt: string;
}

interface ServiceStatus {
  running_jobs: RunningJob[];
  running_specialists: number;
}

type ModalPhase = 'loading' | 'idle' | 'has-tasks' | 'restarting' | 'done' | 'error';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RestartModal({ open, onOpenChange }: Props) {
  const [phase, setPhase] = useState<ModalPhase>('loading');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const fetchStatus = useCallback(async (): Promise<ServiceStatus> => {
    const res = await fetch('/api/services/status');
    if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
    return res.json();
  }, []);

  // Load status when modal opens
  useEffect(() => {
    if (!open) {
      clearPoll();
      return;
    }
    setPhase('loading');
    setErrorMsg('');
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setPhase(s.running_jobs.length === 0 && s.running_specialists === 0 ? 'idle' : 'has-tasks');
      })
      .catch((e) => {
        setErrorMsg(String(e));
        setPhase('error');
      });
  }, [open, fetchStatus]);

  // Auto-poll while in has-tasks phase (every 3s)
  useEffect(() => {
    if (phase !== 'has-tasks') {
      clearPoll();
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchStatus();
        setStatus(s);
        if (s.running_jobs.length === 0 && s.running_specialists === 0) {
          clearPoll();
          setPhase('idle');
        }
      } catch {
        // ignore transient errors during polling
      }
    }, 3000);
    return clearPoll;
  }, [phase, fetchStatus]);

  const doRestart = useCallback(async (force: boolean) => {
    setPhase('restarting');
    try {
      const res = await fetch('/api/services/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      if (res.status === 409) {
        // Blocked — shouldn't happen if called correctly, but handle gracefully
        const data = await res.json();
        setStatus(data);
        setPhase('has-tasks');
        return;
      }
      if (!res.ok) throw new Error(`Restart failed: ${res.status}`);
      // Poll until services are back (bot re-initializes asynchronously)
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          await fetchStatus();
          clearInterval(poll);
          setPhase('done');
        } catch {
          if (attempts >= 15) {
            clearInterval(poll);
            setPhase('done'); // assume done after 30s
          }
        }
      }, 2000);
    } catch (e) {
      setErrorMsg(String(e));
      setPhase('error');
    }
  }, [fetchStatus]);

  const handleClose = () => {
    if (phase === 'restarting') return; // block accidental close
    clearPoll();
    onOpenChange(false);
    // Reset state for next open
    setTimeout(() => {
      setPhase('loading');
      setStatus(null);
      setErrorMsg('');
    }, 200);
  };

  const totalRunning = (status?.running_jobs.length ?? 0) + (status?.running_specialists ?? 0);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent showCloseButton={phase !== 'restarting'} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Restart Services</DialogTitle>
          <DialogDescription>
            Restarts the Telegram bot. Any active agent tasks may be interrupted.
          </DialogDescription>
        </DialogHeader>

        {/* Loading */}
        {phase === 'loading' && (
          <div className="py-6 text-center text-sm text-muted-foreground">Checking running tasks…</div>
        )}

        {/* No running tasks — simple confirm */}
        {phase === 'idle' && (
          <>
            <p className="text-sm text-muted-foreground">No active tasks. Safe to restart now.</p>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button onClick={() => doRestart(false)}>Restart</Button>
            </DialogFooter>
          </>
        )}

        {/* Running tasks */}
        {phase === 'has-tasks' && status && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">{totalRunning} active</Badge>
              <span className="text-muted-foreground">task(s) running. Polling for completion…</span>
            </div>

            {status.running_jobs.length > 0 && (
              <div className="max-h-48 overflow-auto rounded border border-border divide-y divide-border text-xs font-mono">
                {status.running_jobs.map((job) => (
                  <div key={job.id} className="px-3 py-2 flex items-start gap-2">
                    <Badge variant="secondary" className="text-[10px] shrink-0 mt-0.5">{job.status}</Badge>
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{job.taskDescription}</div>
                      <div className="text-muted-foreground text-[10px]">chat {job.chatId} · {new Date(job.createdAt).toLocaleTimeString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {status.running_specialists > 0 && (
              <p className="text-xs text-muted-foreground">
                + {status.running_specialists} specialist agent(s) in flight
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                variant="outline"
                onClick={() => doRestart(false)}
                disabled={totalRunning > 0}
                title={totalRunning > 0 ? 'Waiting for tasks to complete…' : undefined}
              >
                Wait &amp; Restart
              </Button>
              <Button
                variant="destructive"
                onClick={() => doRestart(true)}
              >
                Force Restart
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Restarting */}
        {phase === 'restarting' && (
          <div className="py-8 flex flex-col items-center gap-3">
            <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <p className="text-sm text-muted-foreground">Restarting services…</p>
          </div>
        )}

        {/* Done */}
        {phase === 'done' && (
          <>
            <p className="text-sm text-green-600 dark:text-green-400">Services restarted successfully.</p>
            <DialogFooter>
              <Button onClick={handleClose}>Close</Button>
            </DialogFooter>
          </>
        )}

        {/* Error */}
        {phase === 'error' && (
          <>
            <p className="text-sm text-destructive">Restart failed: {errorMsg}</p>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
