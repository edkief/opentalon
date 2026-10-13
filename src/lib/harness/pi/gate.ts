// Adapted from edkief/ralph@82dc5a5 src/pi/gate.ts and isInside() in src/loop/permissions.ts (MIT).
// Renamed for OpenTalon; the permission request shape and Ralph's rules are left to
// src/lib/agent/harness-gate.ts, which judges a call by OpenTalon's own policy.
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { PiFrame } from './frames';

/**
 * OpenTalon's side of the permission gate: the extension in extensions/pi/opentalon-gate.mjs, which
 * OpenTalon loads into every pi process, puts each tool call to OpenTalon as an `input` dialog, and the
 * call runs only if OpenTalon answers `{"allow":true}`. The constants below are the other half of that file's.
 */

/** The title of a gate dialog. */
export const GATE_TITLE = 'opentalon:gate';

/** The command the extension registers last, which `get_commands` lists once it has loaded. */
export const GATE_COMMAND = 'opentalon-gate';

/** The version of the request the extension sends. */
export const GATE_VERSION = 1;

/**
 * Where the extension is: under the app's root, which is the working directory of `next start`, of
 * the standalone server in the image (/app) and of the scripts. `OPENTALON_PI_GATE` overrides it.
 */
export function gateExtensionPath(): string {
  return process.env.OPENTALON_PI_GATE || join(process.cwd(), 'extensions', 'pi', 'opentalon-gate.mjs');
}

/** The request in a gate dialog's placeholder. */
const GateCallSchema = z.object({
  v: z.literal(GATE_VERSION),
  id: z.string().optional(),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

export type GateCall = z.infer<typeof GateCallSchema>;

export type GateFrame = { id: string } & ({ call: GateCall } | { malformed: string });

/**
 * What OpenTalon decided about a gate request: `allowed` by policy, `approved` by a person, `denied`
 * by a person, `timeout` when nobody answered in time, `blocked` by policy or for want of anyone to ask.
 */
export type GateDecision = 'allowed' | 'approved' | 'denied' | 'timeout' | 'blocked';

/** What OpenTalon answers a gate request with. `reason` is what the agent is told of a block. */
export type GateVerdict =
  | { allow: true; decision: 'allowed' | 'approved' }
  | { allow: false; decision: 'denied' | 'timeout' | 'blocked'; reason: string };

/** Decides a gate request. It must settle: a call waits on it. */
export type GateHandler = (call: GateCall) => Promise<GateVerdict>;

/**
 * A gate dialog in what pi wrote, or nothing for any other frame. A dialog under the gate's title that is
 * not a request OpenTalon understands is `malformed`, and gets blocked: it must never wait on an answer.
 */
export function parseGateFrame(frame: PiFrame): GateFrame | undefined {
  if (frame['type'] !== 'extension_ui_request' || frame['method'] !== 'input' || frame['title'] !== GATE_TITLE) return undefined;
  const id = typeof frame['id'] === 'string' ? frame['id'] : undefined;
  if (!id) return undefined;
  const placeholder = frame['placeholder'];
  let raw: unknown;
  try {
    raw = JSON.parse(typeof placeholder === 'string' ? placeholder : '');
  } catch {
    return { id, malformed: 'the request is not JSON' };
  }
  const call = GateCallSchema.safeParse(raw);
  return call.success ? { id, call: call.data } : { id, malformed: call.error.issues[0]?.message ?? 'the request has the wrong shape' };
}

/** The `value` of the `extension_ui_response` for a verdict. */
export function gateAnswer(verdict: GateVerdict): string {
  return verdict.allow ? JSON.stringify({ allow: true }) : JSON.stringify({ allow: false, reason: verdict.reason });
}

/** The line every block reason ends with, so the agent does not hunt for a way round it. */
export const BLOCKED_SUFFIX = 'Do not try another way round it; carry on without it.';

/**
 * Whether the commands pi lists (its `get_commands` answer's `commands`) include the gate's: the extension
 * registers it after the handler, so it is there only if the extension loaded to its end. An extension that
 * fails to load is logged by pi and left out, and pi then runs every tool call unasked.
 */
export function gateLoaded(commands: unknown): boolean {
  if (!Array.isArray(commands)) return false;
  return commands.some((command: unknown) => {
    if (!command || typeof command !== 'object') return false;
    const { name, source, sourceInfo } = command as { name?: unknown; source?: unknown; sourceInfo?: { path?: unknown } };
    // pi numbers a command that two extensions register: `opentalon-gate:1`.
    if (typeof name !== 'string' || !new RegExp(`^${GATE_COMMAND}(:\\d+)?$`).test(name) || source !== 'extension') return false;
    const path = sourceInfo?.path;
    return typeof path !== 'string' || path.endsWith('opentalon-gate.mjs');
  });
}

/** Why pi is not run without the gate, for the startup check and for the error that stops a session opening. */
export function gateMissingMessage(path = gateExtensionPath()): string {
  const missing = existsSync(path) ? '' : ' The file does not exist.';
  return (
    `pi did not load OpenTalon's permission extension (${path}).${missing} Without it pi runs every tool call unchecked, ` +
    'so OpenTalon will not run pi: check that the file exists and loads, and that harness.pi.args does not undo --extension'
  );
}

/** Whether `path` is `dir` or inside it. Both are taken as they are: resolve them first. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
