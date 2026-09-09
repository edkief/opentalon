import { closeSync, existsSync, openSync } from 'fs';
import { join } from 'path';

export const ONBOARDING_COMPLETE_FILE = '.onboarding-complete';

function markerPath(workspace = process.env.AGENT_WORKSPACE ?? process.cwd()): string {
  return join(workspace, ONBOARDING_COMPLETE_FILE);
}

export function isOnboardingComplete(workspace?: string): boolean {
  return existsSync(markerPath(workspace));
}

export function markOnboardingComplete(workspace?: string): void {
  // Opening with "a" creates the marker if needed without truncating an
  // existing file. Keeping this idempotent makes both onboarding endpoints and
  // workspace migrations safe to retry.
  closeSync(openSync(markerPath(workspace), 'a'));
}
