import fs from 'fs';
import path from 'path';
import SoulManager from './soul-manager';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
const DEFAULT_AGENT_FILE = path.join(WORKSPACE, 'default-agent.txt');

export interface AgentMeta {
  id: string;
  soulPreview: string;
}

class AgentRegistry {
  /** Ensure the agents directory exists, and create a "default" agent only if no agents exist yet. */
  ensureDefaults(): void {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    if (this.listAgents().length === 0) {
      SoulManager.ensureAgentDir('default');
      if (!fs.existsSync(DEFAULT_AGENT_FILE)) {
        fs.writeFileSync(DEFAULT_AGENT_FILE, 'default\n', 'utf-8');
      }
    }
  }

  listAgents(): AgentMeta[] {
    if (!fs.existsSync(AGENTS_DIR)) return [];
    return fs
      .readdirSync(AGENTS_DIR)
      .filter((name) => {
        const dir = path.join(AGENTS_DIR, name);
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'SOUL.md'));
      })
      .sort()
      .map((id) => {
        const soulPath = path.join(AGENTS_DIR, id, 'SOUL.md');
        const raw = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '';
        return { id, soulPreview: raw.slice(0, 120) };
      });
  }

  /** Returns the name of the current default agent. Falls back gracefully if the file is missing or points to a non-existent agent. */
  getDefaultAgent(): string {
    if (fs.existsSync(DEFAULT_AGENT_FILE)) {
      const id = fs.readFileSync(DEFAULT_AGENT_FILE, 'utf-8').trim();
      if (id && this.agentExists(id)) return id;
    }
    // Fallback: prefer 'default' if it exists, else first alphabetical agent
    if (this.agentExists('default')) return 'default';
    const agents = this.listAgents();
    return agents.length > 0 ? agents[0].id : 'default';
  }

  /** Returns true if the given agent id is the current default agent. */
  isDefaultAgent(id: string): boolean {
    return this.getDefaultAgent() === id;
  }

  /** Sets the given agent as the default. Throws if the agent does not exist. */
  setDefaultAgent(id: string): void {
    if (!this.agentExists(id)) throw new Error(`Agent "${id}" not found`);
    fs.writeFileSync(DEFAULT_AGENT_FILE, `${id}\n`, 'utf-8');
  }

  createAgent(id: string): void {
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error('Agent ID must be lowercase alphanumeric with dashes/underscores only');
    }
    if (this.agentExists(id)) {
      throw new Error(`Agent "${id}" already exists`);
    }
    const isFirst = this.listAgents().length === 0;
    SoulManager.ensureAgentDir(id);
    if (isFirst) {
      fs.writeFileSync(DEFAULT_AGENT_FILE, `${id}\n`, 'utf-8');
    }
  }

  renameAgent(oldId: string, newId: string): void {
    if (!/^[a-z0-9_-]+$/.test(newId)) {
      throw new Error('Agent ID must be lowercase alphanumeric with dashes/underscores only');
    }
    if (!this.agentExists(oldId)) throw new Error(`Agent "${oldId}" not found`);
    if (this.agentExists(newId)) throw new Error(`Agent "${newId}" already exists`);
    const wasDefault = this.isDefaultAgent(oldId);
    fs.renameSync(path.join(AGENTS_DIR, oldId), path.join(AGENTS_DIR, newId));
    if (wasDefault) {
      fs.writeFileSync(DEFAULT_AGENT_FILE, `${newId}\n`, 'utf-8');
    }
  }

  deleteAgent(id: string): void {
    const dir = path.join(AGENTS_DIR, id);
    if (!fs.existsSync(dir)) throw new Error(`Agent "${id}" not found`);
    const wasDefault = this.isDefaultAgent(id);
    fs.rmSync(dir, { recursive: true });
    if (wasDefault) {
      const remaining = this.listAgents();
      if (remaining.length > 0) {
        fs.writeFileSync(DEFAULT_AGENT_FILE, `${remaining[0].id}\n`, 'utf-8');
      } else if (fs.existsSync(DEFAULT_AGENT_FILE)) {
        fs.unlinkSync(DEFAULT_AGENT_FILE);
      }
    }
  }

  agentExists(id: string): boolean {
    const dir = path.join(AGENTS_DIR, id);
    return fs.existsSync(dir) && fs.existsSync(path.join(dir, 'SOUL.md'));
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
