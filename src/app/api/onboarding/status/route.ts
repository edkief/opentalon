import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isOnboardingComplete } from '@/lib/onboarding';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

export const dynamic = 'force-dynamic';

export async function GET() {
  const configPath = path.join(WORKSPACE, 'config.yaml');
  const secretsPath = path.join(WORKSPACE, 'secrets.yaml');

  const configExists = fs.existsSync(configPath);
  const secretsExists = fs.existsSync(secretsPath);

  return NextResponse.json({
    configExists,
    secretsExists,
    onboardingComplete: isOnboardingComplete(WORKSPACE),
  });
}
