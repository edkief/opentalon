import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

export interface SoulConfig {
  temperature?: number;
  model?: string;
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
    this.snapshotsDir = path.join(path.dirname(this.soulPath), 'soul-snapshots');
  }

  private parseSoul(): SoulData {
    const fileContent = fs.readFileSync(this.soulPath, 'utf-8');
    const { data, content } = matter(fileContent);

    return {
      content: content.trim(),
      config: {
        temperature: typeof data.temperature === 'number' ? data.temperature : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
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

  writeIdentity(newContent: string): void {
    fs.writeFileSync(this.identityPath, newContent, 'utf-8');
  }

  createSnapshot(): string {
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `soul-${timestamp}.md`;
    const src = fs.readFileSync(this.soulPath, 'utf-8');
    fs.writeFileSync(path.join(this.snapshotsDir, filename), src, 'utf-8');
    return filename;
  }

  listSnapshots(): SoulSnapshot[] {
    if (!fs.existsSync(this.snapshotsDir)) return [];
    return fs
      .readdirSync(this.snapshotsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .map((filename) => {
        const stat = fs.statSync(path.join(this.snapshotsDir, filename));
        return { filename, createdAt: stat.mtime.toISOString() };
      });
  }

  getSnapshot(filename: string): string {
    const p = path.join(this.snapshotsDir, path.basename(filename));
    return fs.readFileSync(p, 'utf-8');
  }

  restoreSnapshot(filename: string): void {
    const content = this.getSnapshot(filename);
    this.write(content);
  }

}

export const soulManager = new SoulManager();
export default SoulManager;
