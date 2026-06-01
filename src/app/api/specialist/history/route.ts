import { NextRequest, NextResponse } from 'next/server';
import { getSpecialistHistory } from '@/lib/agent/log-bus';
import { queryIndex } from '@/lib/agent/orchestration-store';
import type { SpecialistEvent, SpecialistSummary } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function eventsToSummaries(events: SpecialistEvent[]): SpecialistSummary[] {
  const map = new Map<string, SpecialistSummary>();
  for (const ev of events) {
    if (ev.kind === 'spawn') {
      const existing = map.get(ev.specialistId);
      // If the terminal event was already processed (out-of-order), keep its status
      const isCompleted = existing && existing.status !== 'running';
      map.set(ev.specialistId, {
        specialistId: ev.specialistId,
        parentSessionId: ev.parentSessionId,
        taskDescription: ev.taskDescription,
        contextSnapshot: ev.contextSnapshot,
        agentId: ev.agentId ?? existing?.agentId,
        status: isCompleted ? existing!.status : 'running',
        spawnedAt: ev.timestamp,
        background: ev.background,
        parentSpecialistId: ev.parentSpecialistId,
        ...(isCompleted
          ? {
              result: existing!.result,
              durationMs: existing!.durationMs,
              maxStepsUsed: existing!.maxStepsUsed,
              canResume: existing!.canResume,
              modelUsed: existing!.modelUsed,
            }
          : {}),
      });
    } else {
      const existing = map.get(ev.specialistId);
      const status =
        ev.kind === 'complete'
          ? 'complete'
          : ev.kind === 'error'
            ? 'error'
            : ev.kind === 'max_steps'
              ? 'max_steps'
              : 'cancelled';
      map.set(ev.specialistId, {
        specialistId: ev.specialistId,
        parentSessionId: ev.parentSessionId,
        taskDescription: ev.taskDescription,
        status,
        spawnedAt: existing?.spawnedAt ?? ev.timestamp,
        contextSnapshot: existing?.contextSnapshot,
        result: ev.result,
        durationMs: ev.durationMs,
        maxStepsUsed: ev.maxStepsUsed,
        canResume: ev.canResume,
        background: ev.background ?? existing?.background,
        parentSpecialistId: ev.parentSpecialistId ?? existing?.parentSpecialistId,
        agentId: ev.agentId ?? existing?.agentId,
        modelUsed: ev.modelUsed ?? existing?.modelUsed,
      });
    }
  }
  return Array.from(map.values());
}

function matchesSearch(s: SpecialistSummary, q: string): boolean {
  return (
    s.taskDescription?.toLowerCase().includes(q) ||
    (s.agentId?.toLowerCase().includes(q) ?? false) ||
    s.status?.toLowerCase().includes(q) ||
    (s.modelUsed?.toLowerCase().includes(q) ?? false)
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const search = searchParams.get('search')?.trim() || undefined;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '20', 10) || 20));

  // Completed summaries from disk index (paginated)
  const { items: diskItems, total } = await queryIndex({ search, page, pageSize });
  const diskIds = new Set(diskItems.map((i) => i.specialistId));

  // In-memory summaries not yet in the disk index: running jobs (never written to index until done)
  // plus recently-completed ones still ahead of the async write.
  const inMemorySummaries = eventsToSummaries(getSpecialistHistory()).filter(
    (s) => !diskIds.has(s.specialistId),
  );
  const recentItems = search
    ? inMemorySummaries.filter((s) => matchesSearch(s, search.toLowerCase()))
    : inMemorySummaries;

  // Page 1: prepend recent in-memory items not yet on disk
  const items: SpecialistSummary[] = page === 1
    ? [...recentItems, ...diskItems].slice(0, pageSize)
    : diskItems;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return NextResponse.json({ items, total, page, pageSize, totalPages });
}
