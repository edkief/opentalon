import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { configManager } from '../config';
import { buildHarnessSystemPrompt, piProviderEnv, PI_PROVIDERS, runPiTask, type PiTaskModel } from '../harness/pi';
import { agentRegistry, MAX_HARNESS_TIMEOUT_MS } from '../soul';
import type { SoulConfig } from '../soul';
import { getWorkspaceDir } from '../tools/skills';
import type { ApprovalCallback } from '../tools/types';
import { cancellationRegistry } from './cancellation';
import { createHarnessGate } from './harness-gate';
import { HarnessStepFolder, type FoldedStep } from './harness-steps';
import { getApprovalTimeoutMs } from './hitl';
import { emitStep, emitStepLive } from './log-bus';
import { getApiKeyForProvider, parseModelString, resolveModelStrings } from './model-resolver';
import type { SpecialistResult } from './specialist';

/**
 * Harness-backed specialists (#68): an agent whose agent.yml sets `executor: pi` runs its
 * specialist tasks in the pi coding harness instead of the AI SDK loop. Every spawn path
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
export function harnessModels(config: Pick<SoulConfig, 'model' | 'fallbacks'>): PiTaskModel[] {
  const models: PiTaskModel[] = [];
  const unsupported: string[] = [];
  for (const model of resolveModelStrings(config.model, config.fallbacks)) {
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
