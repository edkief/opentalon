import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from '../events';
import { resolvePiConfig, type PiHarnessConfig } from './config';
import { PiSession } from './session';
import { checkPi } from './version';

/** How long a stopped turn gets to settle before its process is ended. */
const ABORT_GRACE_MS = 10_000;

export interface PiTaskModel {
  /** `provider/id`. */
  model: string;
  /** What pi needs in its environment to use the model, e.g. the provider's API key. */
  env: Record<string, string>;
}

export interface PiTaskOptions {
  /** The user prompt. */
  task: string;
  /** Appended to pi's own system prompt. */
  systemPrompt: string;
  /** Tried in order: the first pi accepts runs the task. */
  models: PiTaskModel[];
  /** Where pi runs. */
  cwd: string;
  /** Aborting it stops the run, which then rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Stops the run and rejects with a `PiTaskTimeoutError`; none when absent. */
  timeoutMs?: number;
  /** Names the run's temporary files, e.g. the specialist id. */
  id?: string;
  /** Defaults to `harness.pi` from config.yaml. */
  config?: PiHarnessConfig;
}

export interface PiTaskResult {
  /** pi's final answer. */
  text: string;
  /** `provider/id` the task ran on. */
  modelUsed: string | undefined;
}

/** Same message as a native specialist's timeout (SpecialistTimeoutError in specialist.ts). */
export class PiTaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Specialist timed out after ${timeoutMs / 1000}s`);
    this.name = 'SpecialistTimeoutError';
  }
}

/** What the specialist callers already take as a cancel (see the AbortError branches in specialist.ts). */
function abortError(): Error {
  const error = new Error('The pi run was cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * Run one task in pi to its end, in a process of its own that is always stopped afterwards.
 * Rejects when pi is disabled, not installed or outside its version range, when no model can
 * be started, when the run fails, and on abort or timeout.
 */
export async function runPiTask(options: PiTaskOptions): Promise<PiTaskResult> {
  const config = options.config ?? resolvePiConfig();
  if (!config.enabled) throw new Error('The pi harness is not enabled: set harness.pi.enabled: true in config.yaml');
  const check = await checkPi(config.binary);
  if (!check.ok) throw new Error(`pi is not usable: ${check.detail}`);
  if (options.models.length === 0) throw new Error('No model to run pi with: set a model on the agent or llm.model in config.yaml');
  if (options.signal?.aborted) throw abortError();

  // The system prompt goes in as a file: a supervisor's context can be long, and has no business in argv.
  const promptDir = join(config.sessionDir, '.prompts');
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `${options.id ?? randomUUID()}.md`);
  writeFileSync(promptFile, options.systemPrompt, 'utf-8');
  try {
    const session = await startOnFirstModel(options, config, ['--append-system-prompt', promptFile]);
    try {
      return await runTurn(session, options);
    } finally {
      await session.stop().catch(() => undefined);
    }
  } finally {
    rmSync(promptFile, { force: true });
  }
}

/**
 * The fallback chain applies here only: a model pi refuses at startup (unknown, no key) gives
 * way to the next. Once a turn runs, retrying is pi's own business.
 */
async function startOnFirstModel(options: PiTaskOptions, config: PiHarnessConfig, extraArgs: string[]): Promise<PiSession> {
  const refused: string[] = [];
  for (const { model, env } of options.models) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await PiSession.start({ cwd: options.cwd, env, model, config, extraArgs });
    } catch (cause) {
      // 400: pi answered and said no to this model. Anything else (pi would not start) is not the model's fault.
      if (!(cause instanceof HarnessError) || cause.status !== 400) throw cause;
      console.warn(`[Pi] pi refused ${model}: ${cause.message}`);
      refused.push(`${model}: ${cause.message}`);
    }
  }
  throw new Error(`pi accepted none of the models: ${refused.join('; ')}`);
}

async function runTurn(session: PiSession, options: PiTaskOptions): Promise<PiTaskResult> {
  // The text of each model call; the answer is that of the last call that had any.
  const answers: string[] = [];
  let current: string[] = [];
  session.onEvent((event) => {
    if (event.type === 'step.started') current = [];
    else if (event.type === 'text.ended') current.push(event.text);
    else if (event.type === 'step.ended') {
      const text = current.join('').trim();
      if (text) answers.push(text);
      current = [];
    }
  });

  let stopped: 'abort' | 'timeout' | undefined;
  let grace: NodeJS.Timeout | undefined;
  const stop = (why: 'abort' | 'timeout') => {
    if (stopped) return;
    stopped = why;
    void session.abort().catch(() => undefined);
    // A pi that does not settle after the abort is ended, which ends the turn.
    grace = setTimeout(() => void session.stop().catch(() => undefined), ABORT_GRACE_MS);
  };
  const onAbort = () => stop('abort');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = options.timeoutMs ? setTimeout(() => stop('timeout'), options.timeoutMs) : undefined;

  try {
    const ended = await session.run(options.task);
    if (stopped === 'timeout') throw new PiTaskTimeoutError(options.timeoutMs ?? 0);
    if (stopped === 'abort') throw abortError();
    if (ended.outcome === 'failed') throw new Error(`pi failed: ${ended.error ?? 'unknown error'}`);
    if (ended.outcome === 'aborted') throw new Error('pi stopped the run before it finished');
    return { text: answers.at(-1) ?? '(pi returned no output)', modelUsed: session.model };
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
