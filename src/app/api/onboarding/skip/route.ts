import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from '@/lib/telemetry';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

export const dynamic = 'force-dynamic';

interface ParsedConfig {
  onboarding?: {
    complete?: boolean;
  };
  [key: string]: unknown;
}

// Copy template and optionally append onboarding section (preserves all comments)
function copyTemplate(destPath: string, templatePath: string, addOnboarding: boolean): void {
  if (fs.existsSync(destPath)) {
    // File exists - only append onboarding if needed
    if (!addOnboarding) return;

    const content = fs.readFileSync(destPath, 'utf-8');
    const parsed = parseYaml(content) as ParsedConfig | null;
    if (parsed?.onboarding?.complete === true) {
      return; // Already complete
    }
    const newline = content.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(destPath, content + `${newline}onboarding:\n  complete: true\n`, 'utf-8');
  } else {
    // No file exists - copy from template
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf-8');
      if (addOnboarding) {
        const newline = template.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(destPath, template + `${newline}onboarding:\n  complete: true\n`, 'utf-8');
      } else {
        fs.writeFileSync(destPath, template, 'utf-8');
      }
      logger.info(`[Onboarding] Copied template to ${destPath}`);
    } else {
      // No template - create minimal
      if (addOnboarding) {
        fs.writeFileSync(destPath, 'onboarding:\n  complete: true\n', 'utf-8');
      }
      logger.warn(`[Onboarding] Template not found for ${destPath}`);
    }
  }
}

export async function POST() {
  const configTemplate = path.join(process.cwd(), 'assets', 'config.yaml');
  const secretsTemplate = path.join(process.cwd(), 'assets', 'secrets.yaml');

  const configPath = path.join(WORKSPACE, 'config.yaml');
  const secretsPath = path.join(WORKSPACE, 'secrets.yaml');

  // Handle config.yaml - add onboarding.complete
  copyTemplate(configPath, configTemplate, true);

  // Handle secrets.yaml - just copy template, no onboarding
  copyTemplate(secretsPath, secretsTemplate, false);

  return NextResponse.json({ ok: true });
}
