// Vendored from edkief/ralph@82dc5a5 src/pi/preflight.ts (MIT): the version check only. Ralph's
// model, skills and browser probes are left out.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The pi versions whose RPC protocol this adapter was written and tested against: 1.1.0 onwards. pi 1.x
 * keeps its protocol within the major version, so the range stops short of 2.0. Widening it means recording
 * a session on the new version (scripts/fixtures/pi/) and checking the fixtures still hold.
 */
export const PI_VERSION_RANGE = { min: [1, 1, 0], below: [2, 0, 0] } as const;

export const PI_VERSION_RANGE_TEXT = '>=1.1.0 <2';

/** pi's package. Before 1.0 it was `@mariozechner/pi-coding-agent`, now deprecated and frozen at 0.73.1. */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

const OLD_PI_PACKAGE = '@mariozechner/pi-coding-agent';

type Version = readonly [number, number, number];

/**
 * What `pi --version` prints. pi 0.x wrote it to stderr and 1.x to stdout, so both streams are read.
 */
export async function piVersion(binary: string): Promise<string> {
  const { stdout, stderr } = await run(binary, ['--version'], { timeout: 15_000 });
  return `${stdout}${stderr}`.trim();
}

export function parseVersion(text: string): Version | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function inVersionRange(version: Version): boolean {
  return compare(version, PI_VERSION_RANGE.min) >= 0 && compare(version, PI_VERSION_RANGE.below) < 0;
}

export interface PiCheck {
  ok: boolean;
  /** `x.y.z`, when pi ran and printed one. */
  version?: string;
  detail: string;
}

/** Whether `binary` runs and is a pi this adapter speaks; `detail` says what to do when it is not. */
export async function checkPi(binary: string): Promise<PiCheck> {
  let output: string;
  try {
    output = await piVersion(binary);
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ok: false,
      detail: missing
        ? `\`${binary}\` is not installed or not on the PATH (npm install -g ${PI_PACKAGE})`
        : `\`${binary} --version\` failed: ${(cause as Error).message}`,
    };
  }
  const version = parseVersion(output);
  if (!version) return { ok: false, detail: `\`${binary} --version\` printed "${output}", which is not a version` };
  const text = version.join('.');
  const install = `npm install -g ${PI_PACKAGE}@${PI_VERSION_RANGE.min.slice(0, 2).join('.')}`;
  if (version[0] === 0) {
    return {
      ok: false,
      version: text,
      detail: `${text} is the old ${OLD_PI_PACKAGE}, which is deprecated; OpenTalon needs ${PI_VERSION_RANGE_TEXT}: npm uninstall -g ${OLD_PI_PACKAGE} && ${install}`,
    };
  }
  if (!inVersionRange(version)) {
    return { ok: false, version: text, detail: `${text} is outside the versions OpenTalon is tested with (${PI_VERSION_RANGE_TEXT}): ${install}` };
  }
  return { ok: true, version: text, detail: `${text} (tested with ${PI_VERSION_RANGE_TEXT})` };
}
