import fs from 'fs';
import path from 'path';
import SoulManager from './soul-manager';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const AGENTS_DIR = path.join(WORKSPACE, 'agents');

export interface AgentMeta {
  id: string;
  soulPreview: string;
}

class AgentRegistry {
  /** Ensure the agents directory and "default" agent exist. Does NOT overwrite existing files. */
  ensureDefaults(): void {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    SoulManager.ensureAgentDir('default');
  }

  listAgents(): AgentMeta[] {
    if (!fs.existsSync(AGENTS_DIR)) return [];
    return fs
      .readdirSync(AGENTS_DIR)
      .filter((name) => {
        const dir = path.join(AGENTS_DIR, name);
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'Soul.md'));
      })
      .sort()
      .map((id) => {
        const soulPath = path.join(AGENTS_DIR, id, 'Soul.md');
        const raw = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '';
        return { id, soulPreview: raw.slice(0, 120) };
      });
  }

  createAgent(id: string): void {
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error('Agent ID must be lowercase alphanumeric with dashes/underscores only');
    }
    if (this.agentExists(id)) {
      throw new Error(`Agent "${id}" already exists`);
    }
    SoulManager.ensureAgentDir(id);
  }

  deleteAgent(id: string): void {
    if (id === 'default') throw new Error('Cannot delete the default agent');
    const dir = path.join(AGENTS_DIR, id);
    if (!fs.existsSync(dir)) throw new Error(`Agent "${id}" not found`);
    fs.rmSync(dir, { recursive: true });
  }

  agentExists(id: string): boolean {
    const dir = path.join(AGENTS_DIR, id);
    return fs.existsSync(dir) && fs.existsSync(path.join(dir, 'Soul.md'));
  }

  getSoulManager(agentId: string): SoulManager {
    return SoulManager.forAgent(agentId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __agentRegistry: AgentRegistry | undefined;
}

if (!globalThis.__agentRegistry) {
  globalThis.__agentRegistry = new AgentRegistry();
}

export const agentRegistry = globalThis.__agentRegistry;
export default AgentRegistry;
