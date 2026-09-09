import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { logger } from '@/lib/telemetry';
import { markOnboardingComplete } from '@/lib/onboarding';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

export const dynamic = 'force-dynamic';

// Copy a template only when the destination does not already exist.
function copyTemplate(destPath: string, templatePath: string): void {
  if (fs.existsSync(destPath)) {
    return;
  } else {
    // No file exists - copy from template
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf-8');
      fs.writeFileSync(destPath, template, 'utf-8');
      logger.info(`[Onboarding] Copied template to ${destPath}`);
    } else {
      logger.warn(`[Onboarding] Template not found for ${destPath}`);
    }
  }
}

export async function POST() {
  const configTemplate = path.join(process.cwd(), 'assets', 'config.yaml');
  const secretsTemplate = path.join(process.cwd(), 'assets', 'secrets.yaml');

  const configPath = path.join(WORKSPACE, 'config.yaml');
  const secretsPath = path.join(WORKSPACE, 'secrets.yaml');

  copyTemplate(configPath, configTemplate);

  copyTemplate(secretsPath, secretsTemplate);

  markOnboardingComplete(WORKSPACE);

  return NextResponse.json({ ok: true });
}
