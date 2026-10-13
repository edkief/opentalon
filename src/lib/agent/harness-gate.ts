import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { BLOCKED_SUFFIX, isInside, type GateCall, type GateHandler, type GateVerdict } from '../harness/pi/gate';
import type { HarnessTrust } from '../soul';
import { getDangerousToolNames } from '../tools/dangerous';
import { SHELL_TOOL_NAME } from '../tools/tool-names';
import type { ApprovalCallback } from '../tools/types';
import { waitForApproval } from './hitl';

/**
 * OpenTalon's policy for the tool calls a harness agent's pi puts to the permission gate (#70).
 *
 * pi's tools are judged as OpenTalon's own counterparts, so existing config applies without new
 * keys: `bash` as run_shell, `write` as write_file, `edit` as str_replace_based_edit. Asking goes
 * through the channel's own approval callback, which already auto-approves what `tools.allowlist`
 * covers, shows the Telegram keyboard, or denies where nobody can be asked.
 *
 *   trust     bash        write / edit                         read, ls, find, grep   other tools
 *   gate      ask         run, ask if dangerousTools lists it  run                    ask
 *   workdir   run         run inside the workdir, else block   run                    run
 *   full      run         run                                  run                    run
 *
 * `workdir` does not confine bash: a command's paths cannot be told from its text.
 */

/** pi's tools by the name OpenTalon's own counterpart has, for `tools.allowlist` and `tools.dangerousTools`. */
const OPENTALON_NAMES: Record<string, string> = {
  bash: SHELL_TOOL_NAME,
  write: 'write_file',
  edit: 'str_replace_based_edit',
};

/** pi's tools that only read. */
const READING_TOOLS = new Set(['read', 'ls', 'find', 'grep']);
/** pi's tools that write a file, at `path`. */
const WRITING_TOOLS = new Set(['write', 'edit']);

/** The name a pi tool is asked for and matched against config under. */
export function openTalonToolName(piTool: string): string {
  return OPENTALON_NAMES[piTool] ?? `pi:${piTool}`;
}

export interface HarnessGateOptions {
  trust: HarnessTrust;
  /** Where pi runs; the bound of writes under `workdir` trust. Absolute. */
  workdir: string;
  /** The channel's approval callback. Without one, a call that needs asking is blocked. */
  sendApprovalRequest?: ApprovalCallback;
  /** Names the run in the log. */
  label?: string;
  /** Defaults to `tools.dangerousTools`; for tests. */
  dangerousTools?: () => Set<string>;
  /** Defaults to the HITL gate (hitl.ts); for tests. */
  waitForApproval?: (id: string) => Promise<'approved' | 'denied' | 'timeout'>;
}

const allowed: GateVerdict = { allow: true, decision: 'allowed' };
const blocked = (reason: string): GateVerdict => ({ allow: false, decision: 'blocked', reason: `${reason} ${BLOCKED_SUFFIX}` });

export function createHarnessGate(options: HarnessGateOptions): GateHandler {
  const dangerous = options.dangerousTools ?? getDangerousToolNames;
  const wait = options.waitForApproval ?? ((id: string) => waitForApproval(id));
  const label = options.label ? ` ${options.label}` : '';

  return async (call: GateCall): Promise<GateVerdict> => {
    const verdict = await judge(call);
    const why = verdict.allow ? '' : `: ${verdict.reason}`;
    console.log(`[Harness] gate${label} trust=${options.trust} tool=${call.tool} decision=${verdict.decision}${why}`);
    return verdict;
  };

  async function judge(call: GateCall): Promise<GateVerdict> {
    switch (options.trust) {
      case 'full':
        return allowed;
      case 'workdir':
        return WRITING_TOOLS.has(call.tool) ? judgeWritePath(call, options.workdir) : allowed;
      case 'gate':
      default: {
        if (READING_TOOLS.has(call.tool)) return allowed;
        const name = openTalonToolName(call.tool);
        if (WRITING_TOOLS.has(call.tool) && !dangerous().has(name)) return allowed;
        return ask(name, call.input);
      }
    }
  }

  async function ask(name: string, input: Record<string, unknown>): Promise<GateVerdict> {
    const send = options.sendApprovalRequest;
    if (!send) return blocked(`${name} needs approval, and there is nobody to ask for this run.`);
    const approvalId = randomUUID();
    // In this order, as registry.ts does: the callbacks that answer at once defer to after the wait is registered.
    await send(approvalId, name, input);
    const outcome = await wait(approvalId);
    if (outcome === 'approved') return { allow: true, decision: 'approved' };
    if (outcome === 'timeout') {
      return {
        allow: false,
        decision: 'timeout',
        reason: `The approval request for ${name} timed out: the user did not answer in time. Say so in your answer, so they can retry. ${BLOCKED_SUFFIX}`,
      };
    }
    return { allow: false, decision: 'denied', reason: `The user denied ${name}. ${BLOCKED_SUFFIX}` };
  }
}

/** A write under `workdir` trust: allowed only inside the workdir, symlinks followed. */
function judgeWritePath(call: GateCall, workdir: string): GateVerdict {
  const target = call.input['path'];
  if (typeof target !== 'string' || !target) return blocked(`${call.tool} named no path, so it cannot be checked against the working directory.`);
  const root = realPath(workdir);
  const resolved = realPath(path.resolve(workdir, target));
  if (isInside(root, resolved)) return allowed;
  return blocked(`${call.tool} to ${target} is outside the working directory (${workdir}), and this agent may only write inside it.`);
}

/**
 * `target` with the symlinks of its longest existing ancestor resolved, so a link inside the
 * workdir that points out of it is judged by where it points.
 */
function realPath(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(realpathSync(existing), ...rest);
  } catch {
    return target;
  }
}
