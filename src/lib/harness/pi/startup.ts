import { resolvePiConfig } from './config';
import { checkPi } from './version';

/**
 * Say at startup whether pi is usable, when `harness.pi.enabled` is set. Only ever a log line:
 * the harness is optional, so a missing or unsupported pi must not stop OpenTalon starting.
 */
export async function checkPiAtStartup(): Promise<void> {
  const pi = resolvePiConfig();
  if (!pi.enabled) return;
  const check = await checkPi(pi.binary);
  if (check.ok) console.log(`[Pi] Using pi ${check.detail} (${pi.binary})`);
  else console.warn(`[Pi] harness.pi is enabled but pi is not usable: ${check.detail}`);
}
