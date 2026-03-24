import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const DONE_FILE = join(WORKSPACE, '.migrations-done');

export interface WorkspaceMigration {
  id: string;
  description: string;
  run: () => Promise<void>;
}

function getDone(): string[] {
  if (!existsSync(DONE_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(DONE_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function markDone(id: string): void {
  const done = getDone();
  if (!done.includes(id)) {
    done.push(id);
    writeFileSync(DONE_FILE, JSON.stringify(done, null, 2), 'utf-8');
  }
}

// ── Migration registry (import order = execution order) ──────────────────────

import m001 from './001-rename-personas-to-agents';
import m002 from './002-rename-qdrant-persona-to-agent';
import m003 from './003-rename-md-files-to-uppercase';
import m004 from './004-ensure-tools-dir';
import m005 from './005-init-default-agent-file';

const migrations: WorkspaceMigration[] = [m001, m002, m003, m004, m005];

// ── Runner ───────────────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  // Ensure workspace exists
  if (!existsSync(WORKSPACE)) {
    mkdirSync(WORKSPACE, { recursive: true });
  }

  const done = getDone();
  const pending = migrations.filter((m) => !done.includes(m.id));

  if (pending.length === 0) return;

  console.log(`[Migration] Running ${pending.length} workspace migration(s)…`);

  for (const m of pending) {
    try {
      await m.run();
      markDone(m.id);
      console.log(`[Migration] ✓ ${m.id}: ${m.description}`);
    } catch (err) {
      console.error(`[Migration] ✗ ${m.id} failed:`, err);
      // Stop on first failure — don't skip ahead
      throw err;
    }
  }
}
