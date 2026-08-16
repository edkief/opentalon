'use client';

import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';

interface EmbedStatus {
  enabled: boolean;
  outboxBacklog: number;
  clients: { id: string; label: string; configured: boolean; threads: number }[];
}

/**
 * Compact embed-channel card. Polls /api/services/status (which embeds
 * getEmbedStatus()) every 15s. Renders nothing when the channel is disabled so
 * it stays out of the way for deployments with no host app.
 *
 * The per-client "configured" flag is the point of this card: authentication
 * fails uniformly by design, so a client that is disabled or missing its secret
 * is otherwise indistinguishable from a host sending a wrong credential.
 */
export function EmbedStatusCard() {
  const [status, setStatus] = useState<EmbedStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/services/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { embed?: EmbedStatus };
        if (!cancelled && data.embed) setStatus(data.embed);
      } catch {
        /* transient — keep last known status */
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!status?.enabled) return null;

  const { clients, outboxBacklog } = status;
  const threads = clients.reduce((n, c) => n + c.threads, 0);

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2 shrink-0">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Puzzle className="h-4 w-4" />
        <span className="text-xs font-medium">Embed channel</span>
        <span className="ml-auto text-xs tabular-nums">
          {threads} conversation{threads === 1 ? '' : 's'}
        </span>
      </div>

      {clients.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No clients configured. Add one under <code>embed.clients</code> in config.yaml.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {clients.map((c) => (
            <div key={c.id} className="text-xs flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${c.configured ? 'bg-emerald-500' : 'bg-amber-500'}`}
              />
              <span className="text-foreground">{c.label}</span>
              <span className="text-muted-foreground">
                {c.configured
                  ? `${c.threads} conversation${c.threads === 1 ? '' : 's'}`
                  : 'disabled or missing secret'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        Queued for delivery: <span className="text-foreground tabular-nums">{outboxBacklog}</span>
      </div>
    </div>
  );
}
