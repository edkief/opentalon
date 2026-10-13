/**
 * Run one prompt through the pi coding harness and print what it does, one harness event per
 * line. A smoke test for an installed pi and the harness.pi config (#67).
 *
 * Usage: pnpm pi:smoke "<prompt>" [--cwd <dir>] [--model <provider/id>] [--trust gate|workdir|full]
 *
 * Tool calls go through the permission gate (#70) under `--trust` (default `workdir`: everything
 * runs, writes are kept inside --cwd). Under `gate`, a call that needs approval is asked here, y/n.
 *
 * pi uses its own credentials here (its env vars or ~/.pi auth); handing it OpenTalon's provider
 * keys comes with harness-backed specialists (#68). Exits non-zero unless the turn succeeds.
 */

import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createHarnessGate } from '../src/lib/agent/harness-gate';
import { resolveApproval, waitForApproval } from '../src/lib/agent/hitl';
import { configManager } from '../src/lib/config';
import type { HarnessEvent } from '../src/lib/harness/events';
import { checkPi, PiSession, resolvePiConfig } from '../src/lib/harness/pi';
import { HARNESS_TRUST_LEVELS, type HarnessTrust } from '../src/lib/soul';

const MAX_FIELD = 160;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_FIELD ? `${flat.slice(0, MAX_FIELD)}…` : flat;
}

/** One line per event; deltas and bare activity are left out, since their ends carry the same text. */
function describe(event: HarnessEvent): string | undefined {
  switch (event.type) {
    case 'activity':
    case 'text.delta':
    case 'reasoning.delta':
    case 'tool.started':
    case 'step.streamed':
    case 'compaction.progress':
      return undefined;
    case 'prompt.queued':
      return `prompt      ${clip(event.text)}`;
    case 'step.started':
      return `step        ${event.model ?? ''}`;
    case 'reasoning.ended':
      return `reasoning   ${clip(event.text ?? '')}`;
    case 'text.ended':
      return `text        ${clip(event.text)}`;
    case 'tool.called':
      return `tool        ${event.name ?? '?'} ${clip(JSON.stringify(event.input ?? {}))}`;
    case 'tool.finished':
      return `tool done   ${event.name ?? '?'} ${event.status}${event.exit !== undefined ? ` exit=${event.exit}` : ''} ${clip(event.output ?? '')}`;
    case 'step.ended': {
      const u = event.usage;
      return `step done   ${event.finish ?? ''} in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} cost=$${u.cost.toFixed(4)}${event.files ? ` files=${event.files.join(',')}` : ''}`;
    }
    case 'step.failed':
      return `step failed ${clip(event.error ?? '')}`;
    case 'retry':
      return `retry       attempt=${event.attempt ?? '?'} ${clip(event.error ?? '')}`;
    case 'permission.asked':
      return `gate        ${event.tool} asked`;
    case 'permission.decided':
      return `gate        ${event.tool} ${event.decision}${event.reason ? ` ${clip(event.reason)}` : ''}`;
    case 'execution.ended':
      return `ended       ${event.outcome}${event.error ? ` ${clip(event.error)}` : ''}`;
    default:
      return event.type;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { cwd: { type: 'string' }, model: { type: 'string' }, trust: { type: 'string', default: 'workdir' } },
  });
  const trust = values.trust as HarnessTrust;
  if (!(HARNESS_TRUST_LEVELS as readonly string[]).includes(trust)) {
    console.error(`--trust must be one of ${HARNESS_TRUST_LEVELS.join(', ')}`);
    return 2;
  }
  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    console.error('Usage: pnpm pi:smoke "<prompt>" [--cwd <dir>] [--model <provider/id>] [--trust gate|workdir|full]');
    return 2;
  }

  configManager.load();
  const config = resolvePiConfig();
  const check = await checkPi(config.binary);
  if (!check.ok) {
    console.error(`pi is not usable: ${check.detail}`);
    return 1;
  }
  const cwd = path.resolve(values.cwd ?? process.cwd());
  console.log(`pi ${check.version} (${config.binary}) in ${cwd}, trust=${trust}`);

  // Under `gate`, approvals are asked on this terminal, one at a time.
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let asking = Promise.resolve();
  const gate = createHarnessGate({
    trust,
    workdir: cwd,
    sendApprovalRequest: async (approvalId, toolName, input) => {
      asking = asking.then(async () => {
        const answer = await terminal.question(`approve?    ${toolName} ${clip(JSON.stringify(input))} [y/N] `);
        resolveApproval(approvalId, /^y(es)?$/i.test(answer.trim()));
      });
    },
    waitForApproval: (id) => waitForApproval(id, 10 * 60_000),
  });

  const session = await PiSession.start({ cwd, config, model: values.model, gate });
  console.log(`session     ${session.id} model=${session.model ?? '(pi default)'}`);
  console.log(`            ${session.file}`);
  session.onEvent((event) => {
    const line = describe(event);
    if (line) console.log(line);
  });

  // Ctrl-C stops the turn, as a dashboard cancel will.
  process.once('SIGINT', () => {
    console.log('\ninterrupted: aborting the turn');
    void session.abort().catch(() => undefined);
  });

  try {
    const ended = await session.run(prompt);
    return ended.outcome === 'succeeded' ? 0 : 1;
  } finally {
    terminal.close();
    await session.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
