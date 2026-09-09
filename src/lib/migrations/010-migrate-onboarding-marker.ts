import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { isOnboardingComplete, markOnboardingComplete } from '../onboarding';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

interface LegacyConfig {
  onboarding?: {
    complete?: boolean;
  };
}

const migration: WorkspaceMigration = {
  id: 'migrate-onboarding-marker',
  description: 'Record legacy onboarding completion in .onboarding-complete',
  async run() {
    if (isOnboardingComplete(WORKSPACE)) return;

    const configPath = join(WORKSPACE, 'config.yaml');
    if (!existsSync(configPath)) return;

    // A malformed config cannot establish that onboarding was completed. The
    // migration is still marked done; users without a marker continue through
    // onboarding, while existing markers remain independent of config health.
    let config: LegacyConfig | null;
    try {
      config = parseYaml(readFileSync(configPath, 'utf-8')) as LegacyConfig | null;
    } catch {
      return;
    }

    if (config?.onboarding?.complete === true) {
      markOnboardingComplete(WORKSPACE);
    }
  },
};

export default migration;
