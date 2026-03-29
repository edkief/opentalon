import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, SecretsSchema } from './schema';
import type { AppConfig, AppSecrets } from './schema';

export type ConfigState = 'valid' | 'invalid' | 'missing';

export interface ConfigSnapshot {
  filename: string;
  createdAt: string;
}

// Resolve workspace from env at module load time — this must be available
// before config.yaml is parsed (bootstrap dependency).
const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

class ConfigManager {
  readonly configPath: string;
  readonly secretsPath: string;
  private configSnapshotsDir: string;
  private secretsSnapshotsDir: string;

  state: ConfigState = 'missing';
  error: string | null = null;

  private cachedConfig: AppConfig = {};
  private cachedSecrets: AppSecrets = {};
  private watchers: fs.FSWatcher[] = [];

  constructor() {
    this.configPath = path.join(WORKSPACE, 'config.yaml');
    this.secretsPath = path.join(WORKSPACE, 'secrets.yaml');
    this.configSnapshotsDir = path.join(WORKSPACE, 'config-snapshots');
    this.secretsSnapshotsDir = path.join(WORKSPACE, 'secrets-snapshots');
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  load(): void {
    const configExists = fs.existsSync(this.configPath);
    const secretsExists = fs.existsSync(this.secretsPath);

    if (!configExists && !secretsExists) {
      this.state = 'missing';
      this.error = null;
      this.cachedConfig = {};
      this.cachedSecrets = {};
      return;
    }

    // Parse config.yaml
    let parsedConfig: unknown = {};
    if (configExists) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        parsedConfig = parseYaml(raw) ?? {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state = 'invalid';
        this.error = `config.yaml: ${msg}`;
        this.cachedConfig = {};
        this.cachedSecrets = {};
        console.error('[ConfigManager] Failed to parse config.yaml:', msg);
        return;
      }
    }

    // Parse secrets.yaml
    let parsedSecrets: unknown = {};
    if (secretsExists) {
      try {
        const raw = fs.readFileSync(this.secretsPath, 'utf-8');
        parsedSecrets = parseYaml(raw) ?? {};
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state = 'invalid';
        this.error = `secrets.yaml: ${msg}`;
        this.cachedConfig = {};
        this.cachedSecrets = {};
        console.error('[ConfigManager] Failed to parse secrets.yaml:', msg);
        return;
      }
    }

    // Validate with Zod (schema errors are warnings, not hard failures)
    const configResult = ConfigSchema.safeParse(parsedConfig);
    if (!configResult.success) {
      console.warn('[ConfigManager] config.yaml schema warnings:', configResult.error.format());
      // Still use what we can — partial parse
      this.cachedConfig = (parsedConfig as AppConfig) ?? {};
    } else {
      this.cachedConfig = configResult.data;
    }

    const secretsResult = SecretsSchema.safeParse(parsedSecrets);
    if (!secretsResult.success) {
      console.warn('[ConfigManager] secrets.yaml schema warnings:', secretsResult.error.format());
      this.cachedSecrets = (parsedSecrets as AppSecrets) ?? {};
    } else {
      this.cachedSecrets = secretsResult.data;
    }

    this.state = 'valid';
    this.error = null;
    console.log('[ConfigManager] Loaded successfully');
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get(): AppConfig {
    return this.cachedConfig;
  }

  /**
   * Returns true when onboarding has been explicitly completed via
   * config.yaml → onboarding.complete === true.
   *
   * This is conservative:
   * - If config.yaml is missing, returns false
   * - If the onboarding flag is absent or false, returns false
   * - If the config is invalid, returns false
   */
  isOnboarded(): boolean {
    if (this.state !== 'valid') return false;
    return this.cachedConfig?.onboarding?.complete === true;
  }

  getSecrets(): AppSecrets {
    return this.cachedSecrets;
  }

  isValid(): boolean {
    return this.state !== 'invalid';
  }

  // ── Validation ────────────────────────────────────────────────────────────

  validate(content: string, file: 'config' | 'secrets'): { ok: boolean; error?: string } {
    try {
      const parsed = parseYaml(content);
      const schema = file === 'config' ? ConfigSchema : SecretsSchema;
      const result = schema.safeParse(parsed ?? {});
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return { ok: false, error: `Schema validation: ${issues}` };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `YAML syntax error: ${msg}` };
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  write(content: string, file: 'config' | 'secrets'): void {
    const filePath = file === 'config' ? this.configPath : this.secretsPath;
    fs.writeFileSync(filePath, content, 'utf-8');
    this.load();
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  createSnapshot(file: 'config' | 'secrets'): string {
    const dir = file === 'config' ? this.configSnapshotsDir : this.secretsSnapshotsDir;
    const srcPath = file === 'config' ? this.configPath : this.secretsPath;

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${file}-${timestamp}.yaml`;
    const src = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf-8') : '';
    fs.writeFileSync(path.join(dir, filename), src, 'utf-8');
    return filename;
  }

  listSnapshots(file: 'config' | 'secrets'): ConfigSnapshot[] {
    const dir = file === 'config' ? this.configSnapshotsDir : this.secretsSnapshotsDir;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .reverse()
      .map((filename) => {
        const stat = fs.statSync(path.join(dir, filename));
        return { filename, createdAt: stat.mtime.toISOString() };
      });
  }

  getSnapshotContent(filename: string, file: 'config' | 'secrets'): string {
    const dir = file === 'config' ? this.configSnapshotsDir : this.secretsSnapshotsDir;
    return fs.readFileSync(path.join(dir, path.basename(filename)), 'utf-8');
  }

  restoreSnapshot(filename: string, file: 'config' | 'secrets'): void {
    const content = this.getSnapshotContent(filename, file);
    this.write(content, file);
  }

  // ── Hot Reload ─────────────────────────────────────────────────────────────

  watch(): void {
    // Clean up existing watchers
    this.watchers.forEach((w) => w.close());
    this.watchers = [];

    const watchFile = (filePath: string, label: string) => {
      if (!fs.existsSync(filePath)) return;
      try {
        const watcher = fs.watch(filePath, () => {
          console.log(`[ConfigManager] ${label} changed, hot-reloading…`);
          this.load();
          // Re-apply git identity whenever config or secrets change
          import('../git-config').then(({ applyGitConfig }) => {
            applyGitConfig(this.cachedConfig, this.cachedSecrets);
          }).catch(() => {});
          // Notify dashboard via logBus (import lazily to avoid circular deps)
          import('../agent/log-bus').then(({ logBus }) => {
            logBus.emit('config-changed', {
              file: label,
              valid: this.isValid(),
              error: this.error,
            });
          }).catch(() => {});
        });
        this.watchers.push(watcher);
      } catch {
        // File may not exist yet — that's fine
      }
    };

    watchFile(this.configPath, 'config.yaml');
    watchFile(this.secretsPath, 'secrets.yaml');
  }
}

// ── HMR-safe singleton ────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __configManager: ConfigManager | undefined;
}

if (!globalThis.__configManager) {
  globalThis.__configManager = new ConfigManager();
}

export const configManager = globalThis.__configManager;
