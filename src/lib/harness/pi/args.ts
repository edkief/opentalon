// Adapted from edkief/ralph@82dc5a5 src/pi/args.ts (MIT). The Playwright extension is left out.
import type { PiHarnessConfig } from './config';
import { gateExtensionPath } from './gate';

/**
 * The command line of a pi process: in a session directory, or with no session (a probe).
 *
 * The permission gate (./gate.ts) is always loaded, ahead of `config.args`: a pi process that does
 * not list it afterwards is refused (PiSession.start).
 *
 * Project trust is always given one way or the other, so a user's own `defaultProjectTrust` never
 * decides it. OpenTalon defaults to `--no-approve`: pi may be pointed at any checkout, and trusting
 * it would load that repository's own `.pi` extensions, which is running code from the repository.
 */
export function piArguments(pi: Pick<PiHarnessConfig, 'trustProject' | 'thinking' | 'args'>, sessionDir: string | undefined): string[] {
  return [
    '--mode',
    'rpc',
    ...(sessionDir ? ['--session-dir', sessionDir] : ['--no-session']),
    pi.trustProject ? '--approve' : '--no-approve',
    '--extension',
    gateExtensionPath(),
    ...(pi.thinking ? ['--thinking', pi.thinking] : []),
    ...pi.args,
  ];
}

/** pi's environment: OpenTalon's own, with `extra` (provider keys, for one) laid over it. */
export function piEnvironment(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}
