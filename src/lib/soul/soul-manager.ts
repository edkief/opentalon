import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

export interface SoulConfig {
  temperature?: number;
  model?: string;       // "provider/model" format, e.g. "anthropic/claude-opus-4-5"
  fallbacks?: string[]; // ordered fallback list in "provider/model" format
  tools?: string[];     // allowed tool names; undefined/empty = all tools allowed
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
    this.soulPath = soulPath || path.join(WORKSPACE, 'Soul.md');
    this.identityPath = identityPath || path.join(WORKSPACE, 'Identity.md');
    this.snapshotsDir = path.join(path.dirname(this.soulPath), 'snapshots');
  }

  static forPersona(personaId: string): SoulManager {
    const personaDir = path.join(WORKSPACE, 'personas', personaId);
    return new SoulManager(
      path.join(personaDir, 'Soul.md'),
      path.join(personaDir, 'Identity.md'),
    );
  }

  static ensurePersonaDir(personaId: string): void {
    const dir = path.join(WORKSPACE, 'personas', personaId);
    fs.mkdirSync(dir, { recursive: true });
    const soulPath = path.join(dir, 'Soul.md');
    const identityPath = path.join(dir, 'Identity.md');
    if (!fs.existsSync(soulPath)) fs.writeFileSync(soulPath, '', 'utf-8');
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
    if (merged.temperature !== undefined) clean.temperature = merged.temperature;
    if (merged.model)                      clean.model       = merged.model;
    if (merged.fallbacks?.length)          clean.fallbacks   = merged.fallbacks;
    if (merged.tools?.length)              clean.tools       = merged.tools;
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
    fs.copyFileSync(this.soulPath, path.join(snapDir, 'Soul.md'));
    if (fs.existsSync(this.identityPath)) {
      fs.copyFileSync(this.identityPath, path.join(snapDir, 'Identity.md'));
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
    const soulSnap = path.join(snapDir, 'Soul.md');
    const identitySnap = path.join(snapDir, 'Identity.md');
    if (!fs.existsSync(soulSnap)) throw new Error(`Snapshot "${snapName}" not found`);
    fs.copyFileSync(soulSnap, this.soulPath);
    if (fs.existsSync(identitySnap)) {
      fs.copyFileSync(identitySnap, this.identityPath);
    }
  }

}

export const soulManager = new SoulManager();
export default SoulManager;
