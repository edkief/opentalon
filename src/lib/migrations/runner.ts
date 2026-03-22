import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
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

// ── Migrations ────────────────────────────────────────────────────────────────

const migrations: WorkspaceMigration[] = [
  {
    id: 'rename-personas-to-agents',
    description: 'Rename {WORKSPACE}/personas/ directory to agents/',
    async run() {
      const personasDir = join(WORKSPACE, 'personas');
      const agentsDir = join(WORKSPACE, 'agents');

      if (existsSync(personasDir) && !existsSync(agentsDir)) {
        renameSync(personasDir, agentsDir);
        console.log('[Migration] Renamed personas/ → agents/');
      } else if (existsSync(personasDir) && existsSync(agentsDir)) {
        console.warn('[Migration] Both personas/ and agents/ exist — skipping rename, manual resolution needed');
      }
      // If only agents/ exists or neither exists → no-op
    },
  },
  {
    id: 'rename-qdrant-persona-to-agent',
    description: 'Rename "persona" payload field to "agent" in Qdrant memory collection',
    async run() {
      try {
        const { qdrantClient, COLLECTION_NAME } = await import('../memory/client');

        const exists = await qdrantClient.collectionExists(COLLECTION_NAME);
        if (!exists.exists) {
          console.log('[Migration] Qdrant collection does not exist — skipping');
          return;
        }

        let offset: string | number | undefined = undefined;
        let totalUpdated = 0;

        // Scroll through all points that have a "persona" payload field
        while (true) {
          const result = await qdrantClient.scroll(COLLECTION_NAME, {
            filter: {
              must: [{ key: 'persona', match: { except: [] as string[] } }],
            },
            limit: 100,
            offset,
            with_payload: true,
            with_vector: false,
          });

          if (result.points.length === 0) break;

          const pointIds = result.points.map((p) => p.id);
          const updates = result.points.map((p) => ({
            id: p.id,
            payload: {
              ...(p.payload as Record<string, unknown>),
              agent: (p.payload as Record<string, unknown>).persona,
              persona: undefined,
            },
          }));

          // Set the new "agent" field
          for (const update of updates) {
            await qdrantClient.setPayload(COLLECTION_NAME, {
              points: [update.id],
              payload: { agent: update.payload.agent },
            });
          }

          // Delete the old "persona" field
          await qdrantClient.deletePayload(COLLECTION_NAME, {
            points: pointIds,
            keys: ['persona'],
          });

          totalUpdated += pointIds.length;
          offset = typeof result.next_page_offset === 'string' || typeof result.next_page_offset === 'number'
            ? result.next_page_offset
            : undefined;
          if (!offset) break;
        }

        if (totalUpdated > 0) {
          console.log(`[Migration] Renamed "persona" → "agent" in ${totalUpdated} Qdrant points`);
        } else {
          console.log('[Migration] No Qdrant points with "persona" field found');
        }
      } catch (err) {
        // Non-fatal: Qdrant may not be running
        console.warn('[Migration] Qdrant migration skipped (not reachable):', (err as Error).message);
      }
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

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
