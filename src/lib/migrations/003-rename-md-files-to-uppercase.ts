import { existsSync, renameSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

const migration: WorkspaceMigration = {
  id: 'rename-md-files-to-uppercase',
  description: 'Rename Soul.md → SOUL.md, Identity.md → IDENTITY.md, Memory.md → MEMORY.md',
  async run() {
    const renames: [string, string][] = [
      ['Soul.md', 'SOUL.md'],
      ['Identity.md', 'IDENTITY.md'],
    ];

    // Rename root-level Memory.md
    const oldMemory = join(WORKSPACE, 'Memory.md');
    const newMemory = join(WORKSPACE, 'MEMORY.md');
    if (existsSync(oldMemory) && !existsSync(newMemory)) {
      renameSync(oldMemory, newMemory);
      console.log('[Migration] Renamed Memory.md → MEMORY.md');
    }

    // Rename Soul.md / Identity.md inside each agent dir
    const agentsDir = join(WORKSPACE, 'agents');
    if (!existsSync(agentsDir)) return;

    for (const entry of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, entry);
      if (!statSync(agentDir).isDirectory()) continue;

      for (const [oldName, newName] of renames) {
        const oldPath = join(agentDir, oldName);
        const newPath = join(agentDir, newName);
        if (existsSync(oldPath) && !existsSync(newPath)) {
          renameSync(oldPath, newPath);
          console.log(`[Migration] Renamed agents/${entry}/${oldName} → ${newName}`);
        }
      }

      // Also rename inside snapshot dirs
      const snapshotsDir = join(agentDir, 'snapshots');
      if (!existsSync(snapshotsDir)) continue;
      for (const snap of readdirSync(snapshotsDir)) {
        const snapDir = join(snapshotsDir, snap);
        if (!statSync(snapDir).isDirectory()) continue;
        for (const [oldName, newName] of renames) {
          const oldPath = join(snapDir, oldName);
          const newPath = join(snapDir, newName);
          if (existsSync(oldPath) && !existsSync(newPath)) {
            renameSync(oldPath, newPath);
          }
        }
      }
    }
  },
};

export default migration;
