import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

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

class SoulManager {
  private soulPath: string;
  private identityPath: string;
  private soulData: SoulData | null = null;
  private identityData: IdentityData | null = null;
  private watchers: fs.FSWatcher[] = [];

  constructor(soulPath?: string, identityPath?: string) {
    this.soulPath = soulPath || path.join(process.cwd(), 'assets', 'Soul.md');
    this.identityPath = identityPath || path.join(process.cwd(), 'assets', 'Identity.md');
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

  load(): SoulData {
    this.soulData = this.parseSoul();
    this.identityData = this.parseIdentity();
    return this.soulData;
  }

  getContent(): string {
    if (!this.soulData) {
      this.load();
    }
    return this.soulData!.content;
  }

  getConfig(): SoulConfig {
    if (!this.soulData) {
      this.load();
    }
    return this.soulData!.config;
  }

  getIdentityContent(): string {
    if (!this.identityData) {
      this.load();
    }
    return this.identityData!.content;
  }

  getIdentityConfig(): Record<string, unknown> {
    if (!this.identityData) {
      this.load();
    }
    return this.identityData!.config;
  }

  watch(callback: () => void): void {
    if (process.env.NODE_ENV === 'development') {
      const soulWatcher = fs.watch(this.soulPath, () => {
        console.log('[SoulManager] Soul.md changed, reloading...');
        this.load();
        callback();
      });
      this.watchers.push(soulWatcher);

      const identityWatcher = fs.watch(this.identityPath, () => {
        console.log('[SoulManager] Identity.md changed, reloading...');
        this.load();
        callback();
      });
      this.watchers.push(identityWatcher);
    }
  }

  unwatch(): void {
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers = [];
  }
}

export const soulManager = new SoulManager();
export default SoulManager;
