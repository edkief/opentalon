import fs from 'fs';
import path from 'path';
import type { AppConfig, AppSecrets } from './config/schema';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? '/workspace';

const gitconfigPath   = path.join(WORKSPACE, '.gitconfig');
const credentialsPath = path.join(WORKSPACE, '.git-credentials');

/**
 * Writes (or removes) the workspace-scoped git identity files based on the
 * current config + secrets values.  Called on startup and on every hot-reload
 * so credentials stay in sync without a container restart.
 *
 * Files written:
 *   $AGENT_WORKSPACE/.gitconfig       — [user] name/email + credential helper
 *   $AGENT_WORKSPACE/.git-credentials — https://oauth2:<PAT>@<host>
 *
 * entrypoint.sh exports GIT_CONFIG_GLOBAL pointing at .gitconfig so all git
 * commands in the container pick these up automatically.
 */
export function applyGitConfig(config: AppConfig, secrets: AppSecrets): void {
  const userName  = config.git?.userName;
  const userEmail = config.git?.userEmail;
  const pat       = secrets.git?.pat;
  const patHost   = secrets.git?.patHost ?? 'github.com';

  const hasIdentity    = !!(userName || userEmail);
  const hasCredentials = !!pat;

  if (!hasIdentity && !hasCredentials) {
    console.log('[git-config] no git config — skipping');
    return;
  }

  // ── .gitconfig ──────────────────────────────────────────────────────────────
  const lines: string[] = ['[core]', '\tautocrlf = false'];

  if (hasIdentity) {
    lines.push('[user]');
    if (userName)  lines.push(`\tname = ${userName}`);
    if (userEmail) lines.push(`\temail = ${userEmail}`);
  }

  if (hasCredentials) {
    lines.push('[credential]');
    lines.push(`\thelper = store --file ${credentialsPath}`);
  }

  fs.writeFileSync(gitconfigPath, lines.join('\n') + '\n', { mode: 0o600 });
  console.log('[git-config] wrote', gitconfigPath);

  // ── .git-credentials ────────────────────────────────────────────────────────
  if (hasCredentials) {
    fs.writeFileSync(credentialsPath, `https://oauth2:${pat}@${patHost}\n`, { mode: 0o600 });
    console.log('[git-config] wrote', credentialsPath);
  }
}
