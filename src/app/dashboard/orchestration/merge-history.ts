import type { SpecialistSummary, StepEvent } from '@/lib/agent/log-bus';

export interface SpecialistRecord extends SpecialistSummary {
  steps: StepEvent[];
}

/**
 * Merge a fetched history page into the records the page holds (#87).
 *
 * Running entries are kept even when they aren't on the fetched page, so live
 * runs don't vanish on a page change. For a run that *is* on the page, the
 * stored status wins unless both sides still say `running`: a finished run
 * whose final event the page missed (stream reconnect, tab asleep, restart)
 * must not stay "running" forever. Steps the page already loaded are kept.
 */
export function mergeHistoryPage(
  prev: Map<string, SpecialistRecord>,
  items: SpecialistSummary[],
): Map<string, SpecialistRecord> {
  const next = new Map<string, SpecialistRecord>(
    Array.from(prev.entries()).filter(([, v]) => v.status === 'running'),
  );
  for (const item of items) {
    const held = prev.get(item.specialistId);
    if (held?.status === 'running' && item.status === 'running') continue;
    next.set(item.specialistId, { ...item, steps: held?.steps ?? [] });
  }
  return next;
}
