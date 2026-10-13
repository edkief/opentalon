/**
 * Run one prompt through the pi coding harness and print what it does, one harness event per
 * line. A smoke test for an installed pi and the harness.pi config (#67).
 *
 * Usage: pnpm pi:smoke "<prompt>" [--cwd <dir>] [--model <provider/id>]
 *
 * pi uses its own credentials here (its env vars or ~/.pi auth); handing it OpenTalon's provider
 * keys comes with harness-backed specialists (#68). Exits non-zero unless the turn succeeds.
 */

import { parseArgs } from 'node:util';
import { configManager } from '../src/lib/config';
import type { HarnessEvent } from '../src/lib/harness/events';
import { checkPi, PiSession, resolvePiConfig } from '../src/lib/harness/pi';

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
    case 'execution.ended':
      return `ended       ${event.outcome}${event.error ? ` ${clip(event.error)}` : ''}`;
    default:
      return event.type;
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { cwd: { type: 'string' }, model: { type: 'string' } },
  });
  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    console.error('Usage: pnpm pi:smoke "<prompt>" [--cwd <dir>] [--model <provider/id>]');
    return 2;
  }

  configManager.load();
  const config = resolvePiConfig();
  const check = await checkPi(config.binary);
  if (!check.ok) {
    console.error(`pi is not usable: ${check.detail}`);
    return 1;
  }
  const cwd = values.cwd ?? process.cwd();
  console.log(`pi ${check.version} (${config.binary}) in ${cwd}`);

  const session = await PiSession.start({ cwd, config, model: values.model });
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
    await session.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
