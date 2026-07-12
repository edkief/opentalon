import path from 'node:path';
import { getWorkspaceDir, invalidateSkillsCache } from './tools';

/**
 * Watch the workspace skills directory and invalidate the skills cache on
 * change. Previously lived in Telegram's `setupHandlers`; moved here and called
 * from `src/instrumentation.ts` so skill hot-reload works with Telegram off.
 * globalThis-guarded so dev HMR doesn't stack duplicate watchers.
 */
export function setupSkillsWatcher(): void {
  const g = globalThis as typeof globalThis & { __skillsWatcherStarted?: boolean };
  if (g.__skillsWatcherStarted) return;
  g.__skillsWatcherStarted = true;

  const skillsDir = path.join(getWorkspaceDir(), 'skills');
  import('node:fs').then((fs) => {
    if (!fs.existsSync(skillsDir)) return;
    try {
      fs.watch(skillsDir, { recursive: true }, (_eventType, filename) => {
        if (filename && (filename.endsWith('/SKILL.md') || filename.endsWith('.sh'))) {
          console.log(`[Skills] File changed: ${filename}, invalidating cache`);
          invalidateSkillsCache();
        }
      });
      console.log('[Skills] Watching for changes in:', skillsDir);
    } catch (e) {
      console.warn('[Skills] Failed to watch skills directory:', e);
    }
  });
}
