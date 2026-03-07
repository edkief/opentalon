import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

export const dynamic = 'force-dynamic';

interface ParsedConfig {
  onboarding?: {
    complete?: boolean;
  };
  [key: string]: unknown;
}

export async function GET() {
  const configPath = path.join(WORKSPACE, 'config.yaml');
  const secretsPath = path.join(WORKSPACE, 'secrets.yaml');

  const configExists = fs.existsSync(configPath);
  const secretsExists = fs.existsSync(secretsPath);

  let onboardingComplete = false;
  if (configExists) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(content) as ParsedConfig | null;
      if (parsed?.onboarding?.complete === true) {
        onboardingComplete = true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return NextResponse.json({
    configExists,
    secretsExists,
    onboardingComplete,
  });
}
