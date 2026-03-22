import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

const migration: WorkspaceMigration = {
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
};

export default migration;
