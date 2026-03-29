import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

const DEFAULT_SOUL = `# Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (messages, anything public-facing). Be bold with internal ones (reading, organising, learning).

**Remember you're a guest.** You have access to someone's life — their messages, files, and more. That's intimacy. Treat it with respect.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just… good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.

---

_This file is yours to evolve. As you learn who you are, update it._
`;

export interface SoulConfig {
  temperature?: number;
  model?: string;               // "provider/model" format, e.g. "anthropic/claude-opus-4-5"
  fallbacks?: string[];         // ordered fallback list in "provider/model" format
  tools?: string[];             // allowed tool names; undefined/empty = all tools allowed
  ragEnabled?: boolean;         // whether to inject RAG context (default: true)
  description?: string;              // short description shown in sub-agent selection UI
  canSpawnSubAgents?: boolean;       // opt-in: allow this agent (as specialist) to spawn sub-agents
  allowedSubAgents?: string[];       // explicit allowlist of agent IDs it may spawn
  injectAvailableAgents?: boolean;   // inject the list of available agents into the system prompt
  additionalInstructions?: string;   // extra user instructions injected as a secondary system message
}

export interface HeartbeatConfig {
  enabled: boolean;
  cron: string;    // 5-field cron, e.g. "0 * * * *"
  chatId: string;  // target Telegram chat ID
}

export interface HeartbeatData {
  content: string;                  // markdown body (the checklist)
  config: Partial<HeartbeatConfig>;
}

export interface SoulData {
  content: string;
  config: SoulConfig;
}

export interface IdentityData {
  content: string;
  config: Record<string, unknown>;
}

export interface SoulSnapshot {
  filename: string;
  createdAt: string;
}

class SoulManager {
  private soulPath: string;
  private identityPath: string;
  private snapshotsDir: string;
  constructor(soulPath?: string, identityPath?: string) {
    this.soulPath = soulPath || path.join(WORKSPACE, 'SOUL.md');
    this.identityPath = identityPath || path.join(WORKSPACE, 'IDENTITY.md');
    this.snapshotsDir = path.join(path.dirname(this.soulPath), 'snapshots');
  }

  static forAgent(agentId: string): SoulManager {
    const agentDir = path.join(WORKSPACE, 'agents', agentId);
    return new SoulManager(
      path.join(agentDir, 'SOUL.md'),
      path.join(agentDir, 'IDENTITY.md'),
    );
  }

  static ensureAgentDir(agentId: string): void {
    const dir = path.join(WORKSPACE, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const soulPath = path.join(dir, 'SOUL.md');
    const identityPath = path.join(dir, 'IDENTITY.md');
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, DEFAULT_SOUL, 'utf-8');
    }
    if (!fs.existsSync(identityPath)) fs.writeFileSync(identityPath, '', 'utf-8');
  }

  private parseSoul(): SoulData {
    const fileContent = fs.readFileSync(this.soulPath, 'utf-8');
    const { data, content } = matter(fileContent);

    return {
      content: content.trim(),
      config: {
        temperature: typeof data.temperature === 'number' ? data.temperature : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        fallbacks: Array.isArray(data.fallbacks)
          ? (data.fallbacks as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined,
        tools: Array.isArray(data.tools)
          ? (data.tools as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined,
        ragEnabled: typeof data.ragEnabled === 'boolean' ? data.ragEnabled : undefined,
        description: typeof data.description === 'string' ? data.description : undefined,
        canSpawnSubAgents: typeof data.canSpawnSubAgents === 'boolean' ? data.canSpawnSubAgents : undefined,
        allowedSubAgents: Array.isArray(data.allowedSubAgents)
          ? (data.allowedSubAgents as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined,
        injectAvailableAgents: typeof data.injectAvailableAgents === 'boolean' ? data.injectAvailableAgents : undefined,
        additionalInstructions: typeof data.additionalInstructions === 'string' ? data.additionalInstructions : undefined,
      },
    };
  }

  private parseIdentity(): IdentityData {
    try {
      const fileContent = fs.readFileSync(this.identityPath, 'utf-8');
      const { data, content } = matter(fileContent);

      return {
        content: content.trim(),
        config: data || {},
      };
    } catch {
      return {
        content: '',
        config: {},
      };
    }
  }

  getContent(): string {
    return this.parseSoul().content;
  }

  getConfig(): SoulConfig {
    return this.parseSoul().config;
  }

  getIdentityContent(): string {
    return this.parseIdentity().content;
  }

  getIdentityConfig(): Record<string, unknown> {
    return this.parseIdentity().config;
  }

  write(newContent: string): void {
    fs.writeFileSync(this.soulPath, newContent, 'utf-8');
  }

  /** Update only the YAML front-matter config, preserving the markdown body. */
  writeConfig(config: Partial<SoulConfig>): void {
    const { content, config: existing } = this.parseSoul();
    const merged = { ...existing, ...config };
    const clean: Record<string, unknown> = {};
    if (merged.temperature !== undefined)       clean.temperature       = merged.temperature;
    if (merged.model)                           clean.model             = merged.model;
    if (merged.fallbacks?.length)               clean.fallbacks         = merged.fallbacks;
    if (merged.tools?.length)                   clean.tools             = merged.tools;
    if (merged.ragEnabled !== undefined)        clean.ragEnabled        = merged.ragEnabled;
    if (merged.description)                     clean.description       = merged.description;
    if (merged.canSpawnSubAgents !== undefined)       clean.canSpawnSubAgents       = merged.canSpawnSubAgents;
    if (merged.allowedSubAgents !== undefined)        clean.allowedSubAgents        = merged.allowedSubAgents;
    if (merged.injectAvailableAgents !== undefined)   clean.injectAvailableAgents   = merged.injectAvailableAgents;
    if (merged.additionalInstructions)                clean.additionalInstructions  = merged.additionalInstructions;
    fs.writeFileSync(this.soulPath, matter.stringify(content, clean), 'utf-8');
  }

  writeIdentity(newContent: string): void {
    fs.writeFileSync(this.identityPath, newContent, 'utf-8');
  }

  createSnapshot(): string {
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapName = `snap-${timestamp}`;
    const snapDir = path.join(this.snapshotsDir, snapName);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.copyFileSync(this.soulPath, path.join(snapDir, 'SOUL.md'));
    if (fs.existsSync(this.identityPath)) {
      fs.copyFileSync(this.identityPath, path.join(snapDir, 'IDENTITY.md'));
    }
    return snapName;
  }

  listSnapshots(): SoulSnapshot[] {
    if (!fs.existsSync(this.snapshotsDir)) return [];
    return fs
      .readdirSync(this.snapshotsDir)
      .filter((entry) => {
        const p = path.join(this.snapshotsDir, entry);
        return fs.statSync(p).isDirectory();
      })
      .sort()
      .reverse()
      .map((snapName) => {
        const stat = fs.statSync(path.join(this.snapshotsDir, snapName));
        return { filename: snapName, createdAt: stat.mtime.toISOString() };
      });
  }

  restoreSnapshot(snapName: string): void {
    const snapDir = path.join(this.snapshotsDir, path.basename(snapName));
    const soulSnap = path.join(snapDir, 'SOUL.md');
    const identitySnap = path.join(snapDir, 'IDENTITY.md');
    if (!fs.existsSync(soulSnap)) throw new Error(`Snapshot "${snapName}" not found`);
    fs.copyFileSync(soulSnap, this.soulPath);
    if (fs.existsSync(identitySnap)) {
      fs.copyFileSync(identitySnap, this.identityPath);
    }
  }

  private get heartbeatPath(): string {
    return path.join(path.dirname(this.soulPath), 'HEARTBEAT.md');
  }

  private parseHeartbeat(): HeartbeatData {
    try {
      const fileContent = fs.readFileSync(this.heartbeatPath, 'utf-8');
      const { data, content } = matter(fileContent);
      return {
        content: content.trim(),
        config: {
          enabled: typeof data.enabled === 'boolean' ? data.enabled : undefined,
          cron: typeof data.cron === 'string' ? data.cron : undefined,
          chatId: typeof data.chatId === 'string' ? data.chatId : undefined,
        },
      };
    } catch {
      return { content: '', config: {} };
    }
  }

  getHeartbeatContent(): string {
    return this.parseHeartbeat().content;
  }

  getHeartbeatConfig(): Partial<HeartbeatConfig> {
    return this.parseHeartbeat().config;
  }

  writeHeartbeat(content: string, config: Partial<HeartbeatConfig>): void {
    const clean: Record<string, unknown> = {};
    if (config.enabled !== undefined) clean.enabled = config.enabled;
    if (config.cron !== undefined)    clean.cron    = config.cron;
    if (config.chatId !== undefined)  clean.chatId  = config.chatId;
    fs.writeFileSync(this.heartbeatPath, matter.stringify(content, clean), 'utf-8');
  }

}

export const soulManager = new SoulManager();
export default SoulManager;
