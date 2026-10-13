// Adapted from edkief/ralph@82dc5a5 extensions/ralph-gate.mjs (MIT): renamed for OpenTalon, which loads it
// with `--extension` in every pi process it starts (src/lib/harness/pi/args.ts).
//
// pi has no permission prompt, so this puts every tool call to OpenTalon before the tool runs. The extension
// decides nothing: it forwards the call (an `input` dialog titled `opentalon:gate`, whose placeholder is the
// call as JSON), and OpenTalon answers it from the agent's `harnessTrust` and, where that says to ask, a
// person (see src/lib/agent/harness-gate.ts).
//
// It fails closed. The call runs only when OpenTalon answers exactly `{"allow":true}`; no answer, a cancel,
// a timeout, an abort, an answer that is not that, and any error here, all block it.
//
// No imports: it has to load from wherever OpenTalon is installed, and pi's own package is not there.

/** The dialog title OpenTalon recognises a gate request by. */
export const GATE_TITLE = 'opentalon:gate';

/** The command that proves, in pi's `get_commands`, that this extension loaded to its end. */
export const GATE_COMMAND = 'opentalon-gate';

/** The version of the request, for OpenTalon to refuse a request it does not understand. */
export const GATE_VERSION = 1;

/**
 * The input of a call without the bodies of what it writes: they are no use to a rule, and can be large.
 * Never `command`, `path` or anything else a rule matches on: shortening those could push a denied
 * pattern out of sight.
 */
export function slim(tool, input) {
  if (!input || typeof input !== 'object') return {};
  if (tool === 'write') {
    const { content: _content, ...rest } = input;
    return rest;
  }
  if (tool === 'edit') {
    const { edits, oldText: _old, newText: _new, ...rest } = input;
    return Array.isArray(edits) ? { ...rest, edits: edits.length } : rest;
  }
  return input;
}

/** What blocks the call for an answer: nothing, only for exactly `{"allow":true}`. */
export function verdict(answer) {
  if (typeof answer !== 'string') return { block: true, reason: 'OpenTalon did not answer, so the call was not allowed.' };
  let parsed;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return { block: true, reason: 'OpenTalon answered in a way that was not understood, so the call was not allowed.' };
  }
  if (parsed && typeof parsed === 'object' && parsed.allow === true) return undefined;
  const reason = parsed && typeof parsed === 'object' && typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'OpenTalon did not allow this call.';
  return { block: true, reason };
}

/** The wait for OpenTalon's answer in milliseconds; absent when OpenTalon has none to give. */
function timeoutMs() {
  const value = Number(process.env.OPENTALON_GATE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** @param {any} pi pi's extension API */
export default function opentalonGate(pi) {
  pi.on('tool_call', async (event, ctx) => {
    try {
      const request = JSON.stringify({
        v: GATE_VERSION,
        id: event.toolCallId,
        tool: event.toolName,
        input: slim(event.toolName, event.input),
      });
      const timeout = timeoutMs();
      const answer = await ctx.ui.input(GATE_TITLE, request, { signal: ctx.signal, ...(timeout ? { timeout } : {}) });
      return verdict(answer);
    } catch (cause) {
      return { block: true, reason: `OpenTalon's permission check failed (${cause instanceof Error ? cause.message : String(cause)}), so the call was not allowed.` };
    }
  });

  // Last, so that it is there only if the handler above is.
  pi.registerCommand(GATE_COMMAND, {
    description: "OpenTalon's permission gate: every tool call is put to OpenTalon before it runs",
    handler: async (_args, ctx) => {
      ctx.ui.notify("OpenTalon's permission gate is on.", 'info');
    },
  });
}
