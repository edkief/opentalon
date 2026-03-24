import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const AGENTS_DIR = join(WORKSPACE, 'agents');
const DEFAULT_AGENT_FILE = join(WORKSPACE, 'default-agent.txt');

const migration: WorkspaceMigration = {
  id: 'init-default-agent-file',
  description: 'Create default-agent.txt to persist the configured default agent',
  async run() {
    if (existsSync(DEFAULT_AGENT_FILE)) return; // already present, noop

    // Determine the best default: prefer 'default' agent if it exists on disk
    if (existsSync(join(AGENTS_DIR, 'default', 'SOUL.md'))) {
      writeFileSync(DEFAULT_AGENT_FILE, 'default\n', 'utf-8');
      return;
    }

    // Otherwise use first alphabetical agent found
    if (existsSync(AGENTS_DIR)) {
      const first = readdirSync(AGENTS_DIR)
        .filter((name) => {
          const dir = join(AGENTS_DIR, name);
          return statSync(dir).isDirectory() && existsSync(join(dir, 'SOUL.md'));
        })
        .sort()[0];
      if (first) {
        writeFileSync(DEFAULT_AGENT_FILE, `${first}\n`, 'utf-8');
        return;
      }
    }

    // No agents yet — write 'default' as placeholder (ensureDefaults will create it)
    writeFileSync(DEFAULT_AGENT_FILE, 'default\n', 'utf-8');
  },
};

export default migration;
