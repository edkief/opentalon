// Adapted from edkief/ralph@82dc5a5 src/pi/session.ts and PiHarness.open()/readState() in
// src/pi/harness.ts (MIT). Left out for now: idle stop and revival from the session file (#71),
// steering, and waiting out a compaction before a prompt. The permission gate answers through a
// handler (#70) where Ralph's waits for replyGate().
import { mkdirSync } from 'node:fs';
import { HarnessError, type EventOf, type HarnessEvent } from '../events';
import { piArguments, piEnvironment } from './args';
import { resolvePiConfig, type PiHarnessConfig } from './config';
import { UiRequestSchema, type PiFrame } from './frames';
import { BLOCKED_SUFFIX, gateAnswer, gateLoaded, gateMissingMessage, parseGateFrame, type GateFrame, type GateHandler, type GateVerdict } from './gate';
import { PiCommandError, PiProcess, type PiExit } from './rpc';
import { PiTranslator } from './translate';

/** Time pi gets to start and say who it is. */
const STARTUP_TIMEOUT_MS = 60_000;
/** Time a stopping pi gets before it is killed. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Dialogs a pi extension can open; each waits for an `extension_ui_response`. */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export interface PiSessionOptions {
  /** Where pi runs: the directory its tools work in. */
  cwd: string;
  /** Laid over OpenTalon's environment, e.g. the provider key for `model`. */
  env?: Record<string, string | undefined>;
  /** `provider/id`; pi's own default model when absent. */
  model?: string;
  /** Defaults to `harness.pi` from config.yaml. */
  config?: PiHarnessConfig;
  /** Appended to the command line, after `config.args` (e.g. `--append-system-prompt <file>`). */
  extraArgs?: string[];
  /**
   * Decides each tool call pi puts to OpenTalon through the permission gate (./gate.ts). Without
   * one, every call is blocked: the gate fails closed.
   */
  gate?: GateHandler;
}

export type ExecutionEnded = EventOf<'execution.ended'>;

/**
 * One pi session in a `pi --mode rpc` process of its own, with what the process says translated
 * into harness events (../events.ts). A session runs one turn at a time: `prompt` starts it, the
 * events report it, and `execution.ended` closes it.
 */
export class PiSession {
  private readonly translator: PiTranslator;
  private readonly handlers = new Set<(event: HarnessEvent) => void>();
  /** The gate requests put to OpenTalon and not yet answered: pi's tool calls wait on them. */
  private readonly gates = new Map<string, { call?: string; tool: string }>();
  private stopping = false;

  private constructor(
    readonly id: string,
    /** The `.jsonl` pi keeps the session in. */
    readonly file: string,
    /** `provider/id`, or nothing when pi has no model. */
    public model: string | undefined,
    private readonly process: PiProcess,
    private readonly gate: GateHandler | undefined,
  ) {
    this.translator = new PiTranslator(id);
    process.onFrame((frame) => this.receive(frame));
    process.onExit((exit) => this.lost(exit));
  }

  /** Start a pi process on a new session, on `options.model` when one is given. */
  static async start(options: PiSessionOptions): Promise<PiSession> {
    const config = options.config ?? resolvePiConfig();
    mkdirSync(config.sessionDir, { recursive: true });
    const process = PiProcess.spawn({
      binary: config.binary,
      args: [...piArguments(config, config.sessionDir), ...(options.extraArgs ?? [])],
      env: piEnvironment(options.env),
      cwd: options.cwd,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    let session: PiSession | undefined;
    try {
      await requireGate(process);
      const state = await readState(process);
      session = new PiSession(state.sessionId, state.sessionFile, state.model, process, options.gate);
      if (options.model && options.model !== state.model) await session.setModel(options.model);
      return session;
    } catch (cause) {
      // Through the session once there is one, so its exit reads as asked for, not as lost.
      await (session ? session.stop() : process.stop()).catch(() => undefined);
      throw cause;
    }
  }

  /** A turn is under way: prompted, and its execution has not ended. */
  get running(): boolean {
    return this.translator.running;
  }

  get alive(): boolean {
    return this.process.exit === undefined;
  }

  /** Receive the session's events. Subscribe before `prompt`, or the start of the turn is missed. */
  onEvent(handler: (event: HarnessEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Start a turn. Returns once pi accepts the prompt: the turn itself is observed on the events,
   * and ends with `execution.ended`. A session runs one turn at a time.
   */
  async prompt(text: string): Promise<void> {
    if (this.running) throw new HarnessError(`pi session ${this.id} is already running a turn`, 409, '');
    // Before the request: the first event of the run may be read before its answer is.
    this.translator.markStarting();
    try {
      await this.process.request({ type: 'prompt', message: text });
    } catch (cause) {
      // Nothing started, and nothing is to be reported of it: the caller has the error.
      this.translator.settle();
      throw cause;
    }
  }

  /** Run one turn to its end: `prompt`, then wait for `execution.ended`. */
  async run(text: string): Promise<ExecutionEnded> {
    let off: () => void = () => undefined;
    const ended = new Promise<ExecutionEnded>((resolve) => {
      off = this.onEvent((event) => {
        if (event.type === 'execution.ended') resolve(event);
      });
    });
    try {
      await this.prompt(text);
      return await ended;
    } finally {
      off();
    }
  }

  /** Stop the running turn; it ends with `execution.ended` `aborted`. */
  async abort(): Promise<void> {
    if (!this.alive || !this.running) return;
    this.translator.markStopping();
    await this.process.request({ type: 'abort' });
  }

  /** End the process. A turn still running ends `failed`, since nothing can finish it. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.process.stop();
  }

  private async setModel(model: string): Promise<void> {
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) {
      throw new HarnessError(`Model must be "provider/model", got "${model}"`, 400, '');
    }
    await this.process.request({ type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    this.model = model;
  }

  private receive(frame: PiFrame): void {
    const gate = parseGateFrame(frame);
    if (gate) this.putGate(gate);
    else if (frame.type === 'extension_ui_request') this.answerDialog(frame);
    this.publish(this.translator.push(frame));
    this.cancelGatesOfAnEndedTurn();
  }

  /** Put a tool call to the gate handler, and answer pi with what it decides. */
  private putGate(gate: GateFrame): void {
    if ('malformed' in gate) {
      // Never left waiting: an answer the extension reads as a block, whatever OpenTalon could not read.
      console.warn(`[Pi] pi put a tool call to OpenTalon in a way it does not understand (${gate.malformed}); it is blocked`);
      const reason = `OpenTalon could not read the permission request, so the call was not allowed. ${BLOCKED_SUFFIX}`;
      this.process.write({ type: 'extension_ui_response', id: gate.id, value: gateAnswer({ allow: false, decision: 'blocked', reason }) });
      this.publish([{ type: 'permission.decided', created: Date.now(), session: this.id, id: gate.id, tool: 'unknown', decision: 'blocked', reason }]);
      return;
    }
    const { call } = gate;
    this.gates.set(gate.id, { call: call.id, tool: call.tool });
    this.publish([{ type: 'permission.asked', created: Date.now(), session: this.id, id: gate.id, call: call.id, tool: call.tool, input: call.input }]);
    const decide = this.gate
      ? this.gate(call)
      : Promise.resolve<GateVerdict>({ allow: false, decision: 'blocked', reason: `Nothing in OpenTalon can approve tool calls for this run. ${BLOCKED_SUFFIX}` });
    void decide
      .catch((cause): GateVerdict => ({
        allow: false,
        decision: 'blocked',
        reason: `OpenTalon's permission check failed (${cause instanceof Error ? cause.message : String(cause)}), so the call was not allowed. ${BLOCKED_SUFFIX}`,
      }))
      .then((verdict) => this.answerGate(gate.id, verdict));
  }

  private answerGate(id: string, verdict: GateVerdict): void {
    const pending = this.gates.get(id);
    // Cancelled meanwhile: the turn ended or the process went.
    if (!pending || !this.alive) return;
    this.gates.delete(id);
    this.process.write({ type: 'extension_ui_response', id, value: gateAnswer(verdict) });
    this.publish([{
      type: 'permission.decided',
      created: Date.now(),
      session: this.id,
      id,
      call: pending.call,
      tool: pending.tool,
      decision: verdict.decision,
      ...(verdict.allow ? {} : { reason: verdict.reason }),
    }]);
  }

  /** A turn that ended (aborted, say) leaves no tool call waiting: those still asking are cancelled, which blocks them. */
  private cancelGatesOfAnEndedTurn(): void {
    if (this.translator.running || this.gates.size === 0) return;
    for (const [id, pending] of this.gates) {
      this.process.write({ type: 'extension_ui_response', id, cancelled: true });
      this.publish([{ type: 'permission.decided', created: Date.now(), session: this.id, id, call: pending.call, tool: pending.tool, decision: 'blocked', reason: 'The run ended before the call was decided.' }]);
    }
    this.gates.clear();
  }

  /** Nobody is there to answer an extension's dialog, and the tool or command that opened it waits on one. */
  private answerDialog(frame: PiFrame): void {
    const request = UiRequestSchema.safeParse(frame).data;
    if (!request || !DIALOG_METHODS.has(request.method)) return;
    console.warn(`[Pi] A pi extension opened a ${request.method} dialog; it is cancelled, as nobody can answer during a turn`);
    this.process.write({ type: 'extension_ui_response', id: request.id, cancelled: true });
  }

  private lost(exit: PiExit): void {
    const wasRunning = this.running;
    this.gates.clear();
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`;
    this.publish(this.translator.exited(`pi exited (${how})${exit.stderr ? `: ${exit.stderr}` : ''}`));
    if (!this.stopping) console.warn(`[Pi] pi exited ${wasRunning ? 'during a turn ' : ''}(${how}) session=${this.id}`);
  }

  private publish(events: HarnessEvent[]): void {
    for (const event of events) for (const handler of this.handlers) handler(event);
  }
}

/**
 * pi loads an extension that fails to load without it, and then runs every tool call unchecked. So a
 * process that does not list the gate's command is never used.
 */
async function requireGate(process: PiProcess): Promise<void> {
  const response = await process.request({ type: 'get_commands' }, STARTUP_TIMEOUT_MS);
  if (!gateLoaded((response.data as { commands?: unknown } | undefined)?.commands)) {
    throw new HarnessError(gateMissingMessage(), 502, '');
  }
}

async function readState(process: PiProcess): Promise<{ sessionId: string; sessionFile: string; model: string | undefined }> {
  const response = await process.request({ type: 'get_state' }, STARTUP_TIMEOUT_MS);
  const data = (response.data ?? {}) as { sessionId?: string; sessionFile?: string; model?: { provider?: string; id?: string } | null };
  if (!data.sessionId || !data.sessionFile) {
    throw new PiCommandError('pi reported no session id', 502, JSON.stringify(response.data ?? null));
  }
  const model = data.model?.provider && data.model.id ? `${data.model.provider}/${data.model.id}` : data.model?.id;
  return { sessionId: data.sessionId, sessionFile: data.sessionFile, model };
}
