import { mkdirSync } from 'fs';
import { join } from 'path';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

const migration: WorkspaceMigration = {
  id: 'ensure-tools-dir',
  description: 'Create tools/{bin,lib/python,lib/node/node_modules,share} skeleton for persistent user-installed tools',
  async run() {
    for (const sub of ['bin', 'lib/python', 'lib/node/node_modules', 'share']) {
      mkdirSync(join(WORKSPACE, 'tools', sub), { recursive: true });
    }
  },
};

export default migration;
