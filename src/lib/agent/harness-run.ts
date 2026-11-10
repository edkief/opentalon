import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { configManager } from '../config';
import type { StepUsage } from '../harness/events';
import { buildHarnessChatPrompt, buildHarnessSystemPrompt, piProviderEnv, PI_PROVIDERS, renderTranscript, runPiTask, type PiTaskModel } from '../harness/pi';
import { retrieveContext } from '../memory';
import type { MemoryScope } from '../memory/types';
import { agentRegistry, MAX_HARNESS_TIMEOUT_MS } from '../soul';
import type { SoulConfig } from '../soul';
import { getWorkspaceDir } from '../tools/skills';
import type { ApprovalCallback } from '../tools/types';
import { cancellationRegistry } from './cancellation';
import { createHarnessGate } from './harness-gate';
import { HarnessStepFolder, type FoldedStep } from './harness-steps';
import { getApprovalTimeoutMs } from './hitl';
import { emitStep, emitStepLive } from './log-bus';
import { memoryManager } from './memory-manager';
import { getApiKeyForProvider, parseModelString, resolveModelStrings } from './model-resolver';
import type { SpecialistResult } from './specialist';
import type { Message } from './types';

/**
 * Harness-backed agents: an agent whose agent.yml sets `executor: pi` runs in the pi coding
 * harness instead of the AI SDK loop, both when it is talked to directly (runHarnessChat, #93,
 * called from LLMExecutor.chat for every channel) and as a specialist (#68).
 *
 * Specialists (runHarnessSpecialist): every spawn path
 * (sync, inline background, pg-boss background) branches here, and gets back what a native
 * run gives it: a SpecialistResult, an AbortError on cancel, an Error otherwise. The callers'
 * lifecycle events, job records and result truncation are untouched.
 *
 * Every tool call pi makes is put to OpenTalon through the permission gate (#70) and judged by
 * the agent's `harnessTrust` (./harness-gate.ts); approvals go through `sendApprovalRequest`.
 */

const DEFAULT_SPECIALIST_TIMEOUT_MS = 600_000;

export function isHarnessAgent(agentId: string): boolean {
  return agentRegistry.getSoulManager(agentId).getConfig().executor === 'pi';
}

/** The harness a specialist of this agent runs in, for its spawn event (#69); undefined when native. */
export function executorOf(agentId: string): 'pi' | undefined {
  return isHarnessAgent(agentId) ? 'pi' : undefined;
}

/**
 * How long a specialist of this agent may run: the agent's `harnessTimeoutMs` for a harness
 * agent, else `llm.specialistTimeoutMs`, else 10 minutes. The same for native agents as before.
 */
export function specialistTimeoutFor(agentId: string): number {
  const global = configManager.get().llm?.specialistTimeoutMs ?? DEFAULT_SPECIALIST_TIMEOUT_MS;
  const config = agentRegistry.getSoulManager(agentId).getConfig();
  const ms = config.executor === 'pi' ? (config.harnessTimeoutMs ?? global) : global;
  return Math.min(ms, MAX_HARNESS_TIMEOUT_MS); // setTimeout fires at once above 2^31-1 ms
}

/** Where pi runs for this agent: its `workdir` (relative to the agent workspace), or the workspace. */
export function harnessWorkdir(config: Pick<SoulConfig, 'workdir'>): string {
  const workspace = getWorkspaceDir();
  if (!config.workdir) return workspace;
  return path.isAbsolute(config.workdir) ? config.workdir : path.resolve(workspace, config.workdir);
}

/**
 * The agent's model chain as pi can take it, each with its provider's key in pi's own env var.
 * Models of providers pi cannot be handed a key for (custom OpenAI-compatible providers) are
 * left out; with none left, that is the error.
 */
export function harnessModels(config: Pick<SoulConfig, 'model' | 'fallbacks'>, modelOverride?: string): PiTaskModel[] {
  const models: PiTaskModel[] = [];
  const unsupported: string[] = [];
  // A chat's model pin replaces the whole chain, as it does natively (LLMExecutor.chat).
  const chain = modelOverride ? resolveModelStrings(modelOverride, []) : resolveModelStrings(config.model, config.fallbacks);
  for (const model of chain) {
    const provider = parseModelString(model)?.provider;
    const env = provider ? piProviderEnv(provider, getApiKeyForProvider(provider)) : undefined;
    if (env) models.push({ model, env });
    else unsupported.push(model);
  }
  if (unsupported.length > 0) {
    console.warn(`[Harness] pi cannot run ${unsupported.join(', ')}: only ${PI_PROVIDERS.join(', ')} models are supported`);
  }
  if (models.length === 0) {
    throw new Error(
      `pi can only run models from ${PI_PROVIDERS.join(', ')}; this agent's models (${unsupported.join(', ') || 'none'}) ` +
        'are not among them. Custom providers from secrets.yaml are not supported by the pi harness yet.',
    );
  }
  return models;
}

export interface HarnessSpecialistOptions {
  agentId: string;
  /**
   * Registers the run for cancellation (cancellationRegistry), names its temporary files, and
   * attributes its steps in the thought stream; without one, no steps are emitted, as natively.
   */
  specialistId?: string;
  /** The thread the run's steps hang off: the thread that spawned it. */
  threadId?: string;
  taskDescription: string;
  contextSnapshot: string;
  /**
   * Stop the run after this long. The sync and inline paths already race the run against
   * `specialistTimeoutFor` and leave this unset; the pg-boss path has no race of its own.
   */
  timeoutMs?: number;
  /**
   * The approval callback of the channel the run was spawned from, for the tool calls the gate
   * asks about. Without one, those calls are blocked.
   */
  sendApprovalRequest?: ApprovalCallback;
}

/** How long pi's gate extension waits for an answer: past the approval timeout, so OpenTalon's answer comes first. */
const GATE_WAIT_MARGIN_MS = 30_000;

export async function runHarnessSpecialist(options: HarnessSpecialistOptions): Promise<SpecialistResult> {
  const { agentId, specialistId, threadId, taskDescription, contextSnapshot, timeoutMs, sendApprovalRequest } = options;
  const sm = agentRegistry.getSoulManager(agentId);
  const config = sm.getConfig();

  const cwd = harnessWorkdir(config);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`The workdir of agent "${agentId}" does not exist: ${cwd}`);
  }

  const controller = specialistId ? cancellationRegistry.register(specialistId) : undefined;
  // #69: pi's events as the StepEvents a native specialist emits.
  const folder = specialistId
    ? new HarnessStepFolder({ specialistId, threadId, harness: 'pi', progressive: configManager.get().llm?.progressiveSteps === true })
    : undefined;
  const emit = (steps: FoldedStep[]) => {
    for (const step of steps) (step.persist ? emitStep : emitStepLive)(step.event);
  };
  const startMs = Date.now();
  const label = `agent=${agentId}${specialistId ? ` specialist=${specialistId}` : ''}`;
  try {
    const gateTimeout = String(getApprovalTimeoutMs() + GATE_WAIT_MARGIN_MS);
    const models = harnessModels(config).map((m) => ({ ...m, env: { ...m.env, OPENTALON_GATE_TIMEOUT_MS: gateTimeout } }));
    const trust = config.harnessTrust ?? 'gate';
    console.log(`[Harness] pi run starting ${label} cwd=${cwd} trust=${trust} models=${models.map((m) => m.model).join(',')} timeoutMs=${timeoutMs ?? 'caller'}`);
    const result = await runPiTask({
      task: taskDescription,
      systemPrompt: buildHarnessSystemPrompt({ soul: sm.getContent(), contextSnapshot }),
      models,
      cwd,
      signal: controller?.signal,
      timeoutMs,
      id: specialistId,
      gate: createHarnessGate({ trust, workdir: cwd, sendApprovalRequest, label }),
      onEvent: folder
        ? (event) => {
            // The thought stream is a view: a fault in it must not fail the run.
            try {
              emit(folder.push(event));
            } catch (err) {
              console.warn(`[Harness] step folding failed ${label}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        : undefined,
    });
    console.log(`[Harness] pi run finished ${label} model=${result.modelUsed} duration=${Date.now() - startMs}ms`);
    return { text: result.text, hitMaxSteps: false, modelUsed: result.modelUsed };
  } catch (err) {
    console.warn(`[Harness] pi run failed ${label} duration=${Date.now() - startMs}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    // A run cancelled or timed out before pi reported its end still keeps the step it was on.
    if (folder) emit(folder.finish());
    if (specialistId) cancellationRegistry.unregister(specialistId);
  }
}

export interface HarnessChatOptions {
  agentId: string;
  /** The chat the turn came from: names its steps' session, and is where its approvals are asked. */
  chatId?: string;
  threadId?: string;
  turnId: string;
  /** The conversation so far, ending with the message this turn answers. */
  messages: Message[];
  /** The channel's context line (chat id, workspace, ...), as the native loop gets it. */
  context?: string;
  /** Set when notes may be recalled for the message, as natively (the channel's memory scope). */
  memoryScope?: MemoryScope;
  /** A chat's model pin: replaces the agent's model chain. */
  modelOverride?: string;
  /** A scheduled run's id, carried on the turn's steps as natively. */
  runId?: string;
  /** Stops the run: `/cancel`, the dashboard, a caller's own signal. */
  signal?: AbortSignal;
  sendApprovalRequest?: ApprovalCallback;
}

export interface HarnessChatResult {
  text: string;
  modelUsed: string | undefined;
  usage: StepUsage;
}

/**
 * One turn of a pi agent talked to directly (#93): the message, with the soul, Core Memory, the
 * notes recalled for it, the channel context and the conversation so far, goes to a fresh pi
 * process, which runs its own loop to the end. Its final answer is the reply; no OpenTalon model
 * call runs before or after it. Its steps go to the thought stream as the turn's own.
 *
 * Rejects with an AbortError when stopped, a PiTaskTimeoutError after the agent's timeout, and an
 * Error when pi cannot run (disabled, missing, no usable model, a missing workdir).
 */
export async function runHarnessChat(options: HarnessChatOptions): Promise<HarnessChatResult> {
  const { agentId, chatId, threadId, turnId, messages, context, memoryScope, modelOverride, runId, signal, sendApprovalRequest } = options;
  const sm = agentRegistry.getSoulManager(agentId);
  const config = sm.getConfig();

  const cwd = harnessWorkdir(config);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`The workdir of agent "${agentId}" does not exist: ${cwd}`);
  }
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const message = lastUser >= 0 ? messages[lastUser].content : '';
  if (!message.trim()) throw new Error('There is no message for pi to answer');

  const recalledNotes = await recallFor(message, agentId, memoryScope, config.ragEnabled ?? true);
  const systemPrompt = buildHarnessChatPrompt({
    soul: sm.getContent(),
    coreMemory: memoryManager.getContent(),
    context,
    recalledNotes,
    transcript: renderTranscript(messages.slice(0, lastUser)),
  });

  const folder = new HarnessStepFolder({
    turn: { turnId, sessionId: chatId ?? 'web', agentId, runId, systemPrompt },
    threadId: threadId ?? chatId,
    harness: 'pi',
    progressive: configManager.get().llm?.progressiveSteps === true,
  });
  const emit = (steps: FoldedStep[]) => {
    for (const step of steps) (step.persist ? emitStep : emitStepLive)(step.event);
  };
  const startMs = Date.now();
  const label = `agent=${agentId} turn=${turnId}`;
  try {
    const gateTimeout = String(getApprovalTimeoutMs() + GATE_WAIT_MARGIN_MS);
    const models = harnessModels(config, modelOverride).map((m) => ({ ...m, env: { ...m.env, OPENTALON_GATE_TIMEOUT_MS: gateTimeout } }));
    const trust = config.harnessTrust ?? 'gate';
    const timeoutMs = specialistTimeoutFor(agentId);
    console.log(`[Harness] pi turn starting ${label} cwd=${cwd} trust=${trust} models=${models.map((m) => m.model).join(',')} timeoutMs=${timeoutMs}`);
    const result = await runPiTask({
      task: message,
      systemPrompt,
      models,
      cwd,
      signal,
      timeoutMs,
      id: `turn-${turnId}`,
      gate: createHarnessGate({ trust, workdir: cwd, sendApprovalRequest, label }),
      onEvent: (event) => {
        // The thought stream is a view: a fault in it must not fail the turn.
        try {
          emit(folder.push(event));
        } catch (err) {
          console.warn(`[Harness] step folding failed ${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
    console.log(`[Harness] pi turn finished ${label} model=${result.modelUsed} duration=${Date.now() - startMs}ms`);
    return { text: result.text, modelUsed: result.modelUsed, usage: result.usage };
  } catch (err) {
    console.warn(`[Harness] pi turn failed ${label} duration=${Date.now() - startMs}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    emit(folder.finish());
  }
}

/** The notes recalled for the message, under the native loop's conditions (LLMExecutor.chat). */
async function recallFor(query: string, agentId: string, scope: MemoryScope | undefined, ragEnabled: boolean): Promise<string | undefined> {
  const memoryEnabled = configManager.get().memory?.enabled ?? process.env.ENABLE_MEMORY === 'true';
  if (!memoryEnabled || !scope || !ragEnabled) return undefined;
  try {
    return (await retrieveContext({ query, scope, limit: 5, agent: agentId })) || undefined;
  } catch (err) {
    console.error('[Harness] RAG retrieval failed:', err);
    return undefined;
  }
}
