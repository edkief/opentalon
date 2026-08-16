/**
 * Embed channel lifecycle.
 *
 * Unlike email there is no connection to manage — the channel is inbound HTTP,
 * so "starting" it means registering the outbound sender and the retention
 * sweep. Both are registered unconditionally at boot: the sender is a cheap
 * no-op while the channel is disabled, and registering regardless means flipping
 * `embed.enabled` in config.yaml takes effect on the next request with no
 * restart and no hot-reload listener.
 */

import { getEmbedConfig, getEmbedClient, listEmbedClientIds } from './config';
import { countEmbedOutbox, countEmbedThreadsByClient, sweepEmbedInbound, sweepEmbedOutbox } from '../db/embed';
import { registerEmbedSender } from './send';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function setupEmbedChannel(): void {
  const g = globalThis as typeof globalThis & { __embedChannelSetup?: boolean };
  if (g.__embedChannelSetup) return;
  g.__embedChannelSetup = true;

  registerEmbedSender();

  // Retention sweep, mirroring the tool-dump sweep in src/instrumentation.ts:62.
  // Re-reads config each pass so a changed window applies without a restart.
  const runSweep = async () => {
    const cfg = getEmbedConfig();
    if (!cfg) return;
    try {
      const [outbox, inbound] = await Promise.all([
        sweepEmbedOutbox(cfg.outboxRetentionHours),
        sweepEmbedInbound(cfg.outboxRetentionHours),
      ]);
      if (outbox > 0 || inbound > 0) {
        console.log(`[embed] Swept ${outbox} outbox row(s) and ${inbound} idempotency key(s)`);
      }
    } catch (err) {
      console.error('[embed] Retention sweep failed:', err);
    }
  };

  runSweep();
  setInterval(runSweep, SWEEP_INTERVAL_MS).unref();

  console.log('[embed] Channel registered');
}

export interface EmbedStatus {
  enabled: boolean;
  outboxBacklog: number;
  clients: { id: string; label: string; configured: boolean; threads: number }[];
}

/** Status payload for /api/services/status and the dashboard card. */
export async function getEmbedStatus(): Promise<EmbedStatus> {
  const cfg = getEmbedConfig();
  if (!cfg) return { enabled: false, outboxBacklog: 0, clients: [] };

  const ids = listEmbedClientIds();
  const clients = await Promise.all(
    ids.map(async (id) => {
      const client = getEmbedClient(id);
      return {
        id,
        label: client?.label ?? id,
        // False when the client is disabled or has no secret — the most common
        // misconfiguration, and invisible otherwise since auth fails uniformly.
        configured: client !== null,
        threads: await countEmbedThreadsByClient(id),
      };
    }),
  );

  return { enabled: true, outboxBacklog: await countEmbedOutbox(), clients };
}

export { getEmbedConfig, getEmbedClient } from './config';
export type { ResolvedEmbedClient } from './config';
