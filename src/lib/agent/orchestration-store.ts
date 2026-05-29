import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceDir } from '../tools/skills';
import type { SpecialistEvent, SpecialistSummary, StepEvent } from './log-bus';

interface RunRecord {
  summary: SpecialistSummary;
  steps: StepEvent[];
}

function getOrchestrationDir(): string {
  return path.join(getWorkspaceDir(), 'orchestration');
}

function getRunsDir(): string {
  return path.join(getOrchestrationDir(), 'runs');
}

function getIndexPath(): string {
  return path.join(getOrchestrationDir(), 'index.jsonl');
}

function getRunPath(specialistId: string): string {
  return path.join(getRunsDir(), `${specialistId}.json`);
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(getRunsDir(), { recursive: true });
}

export async function persistSpecialistEvent(event: SpecialistEvent): Promise<void> {
  await ensureDirs();
  const runPath = getRunPath(event.specialistId);

  if (event.kind === 'spawn') {
    const summary: SpecialistSummary = {
      specialistId: event.specialistId,
      parentSessionId: event.parentSessionId,
      taskDescription: event.taskDescription,
      contextSnapshot: event.contextSnapshot,
      agentId: event.agentId,
      status: 'running',
      spawnedAt: event.timestamp,
      background: event.background,
      parentSpecialistId: event.parentSpecialistId,
    };
    await fs.writeFile(runPath, JSON.stringify({ summary, steps: [] }), 'utf-8');
    return;
  }

  // Terminal event — update run file then append to index
  let record: RunRecord;
  try {
    record = JSON.parse(await fs.readFile(runPath, 'utf-8')) as RunRecord;
  } catch {
    record = {
      summary: {
        specialistId: event.specialistId,
        parentSessionId: event.parentSessionId,
        taskDescription: event.taskDescription,
        status: 'running',
        spawnedAt: event.timestamp,
      },
      steps: [],
    };
  }

  const status =
    event.kind === 'complete'
      ? 'complete'
      : event.kind === 'error'
        ? 'error'
        : event.kind === 'max_steps'
          ? 'max_steps'
          : 'cancelled';

  record.summary = {
    ...record.summary,
    status,
    result: event.result,
    durationMs: event.durationMs,
    maxStepsUsed: event.maxStepsUsed,
    canResume: event.canResume,
    background: event.background ?? record.summary.background,
    parentSpecialistId: event.parentSpecialistId ?? record.summary.parentSpecialistId,
    agentId: event.agentId ?? record.summary.agentId,
    modelUsed: event.modelUsed ?? record.summary.modelUsed,
  };

  await fs.writeFile(runPath, JSON.stringify(record), 'utf-8');
  await fs.appendFile(getIndexPath(), JSON.stringify(record.summary) + '\n', 'utf-8');
}

export async function persistStepEvent(event: StepEvent): Promise<void> {
  if (!event.specialistId) return;
  const runPath = getRunPath(event.specialistId);
  try {
    const record = JSON.parse(await fs.readFile(runPath, 'utf-8')) as RunRecord;
    record.steps.push(event);
    await fs.writeFile(runPath, JSON.stringify(record), 'utf-8');
  } catch {
    // Run file doesn't exist yet (spawn not yet persisted) — skip
  }
}

export async function loadRunSteps(specialistId: string): Promise<StepEvent[]> {
  try {
    const record = JSON.parse(await fs.readFile(getRunPath(specialistId), 'utf-8')) as RunRecord;
    return record.steps ?? [];
  } catch {
    return [];
  }
}

export async function queryIndex(opts: {
  search?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: SpecialistSummary[]; total: number }> {
  let content: string;
  try {
    content = await fs.readFile(getIndexPath(), 'utf-8');
  } catch {
    return { items: [], total: 0 };
  }

  const lines = content.trim().split('\n').filter(Boolean);

  // Deduplicate by specialistId — last line wins (handles any duplicate writes)
  const byId = new Map<string, SpecialistSummary>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SpecialistSummary;
      byId.set(entry.specialistId, entry);
    } catch {
      // ignore malformed lines
    }
  }

  let entries = Array.from(byId.values()).sort(
    (a, b) => new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime(),
  );

  if (opts.search) {
    const q = opts.search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.taskDescription?.toLowerCase().includes(q) ||
        e.agentId?.toLowerCase().includes(q) ||
        e.status?.toLowerCase().includes(q) ||
        e.modelUsed?.toLowerCase().includes(q),
    );
  }

  const total = entries.length;
  const start = (opts.page - 1) * opts.pageSize;
  return { items: entries.slice(start, start + opts.pageSize), total };
}
