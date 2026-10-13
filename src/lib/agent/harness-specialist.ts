import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { configManager } from '../config';
import { buildHarnessSystemPrompt, piProviderEnv, PI_PROVIDERS, runPiTask, type PiTaskModel } from '../harness/pi';
import { agentRegistry } from '../soul';
import type { SoulConfig } from '../soul';
import { getWorkspaceDir } from '../tools/skills';
import { cancellationRegistry } from './cancellation';
import { getApiKeyForProvider, parseModelString, resolveModelStrings } from './model-resolver';
import type { SpecialistResult } from './specialist';

/**
 * Harness-backed specialists (#68): an agent whose agent.yml sets `executor: pi` runs its
 * specialist tasks in the pi coding harness instead of the AI SDK loop. Every spawn path
 * (sync, inline background, pg-boss background) branches here, and gets back what a native
 * run gives it: a SpecialistResult, an AbortError on cancel, an Error otherwise. The callers'
 * lifecycle events, job records and result truncation are untouched.
 *
 * Until #70 adds the permission gate, pi runs ungated: its bash/write/edit tools are not
 * checked against tools.dangerousTools and are not confined to the workdir.
 */

const DEFAULT_SPECIALIST_TIMEOUT_MS = 600_000;

export function isHarnessAgent(agentId: string): boolean {
  return agentRegistry.getSoulManager(agentId).getConfig().executor === 'pi';
}

/**
 * How long a specialist of this agent may run: the agent's `harnessTimeoutMs` for a harness
 * agent, else `llm.specialistTimeoutMs`, else 10 minutes. The same for native agents as before.
 */
export function specialistTimeoutFor(agentId: string): number {
  const global = configManager.get().llm?.specialistTimeoutMs ?? DEFAULT_SPECIALIST_TIMEOUT_MS;
  const config = agentRegistry.getSoulManager(agentId).getConfig();
  return config.executor === 'pi' ? (config.harnessTimeoutMs ?? global) : global;
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
  /** Registers the run for cancellation (cancellationRegistry) and names its temporary files. */
  specialistId?: string;
  taskDescription: string;
  contextSnapshot: string;
  /**
   * Stop the run after this long. The sync and inline paths already race the run against
   * `specialistTimeoutFor` and leave this unset; the pg-boss path has no race of its own.
   */
  timeoutMs?: number;
}

export async function runHarnessSpecialist(options: HarnessSpecialistOptions): Promise<SpecialistResult> {
  const { agentId, specialistId, taskDescription, contextSnapshot, timeoutMs } = options;
  const sm = agentRegistry.getSoulManager(agentId);
  const config = sm.getConfig();

  const cwd = harnessWorkdir(config);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`The workdir of agent "${agentId}" does not exist: ${cwd}`);
  }

  const controller = specialistId ? cancellationRegistry.register(specialistId) : undefined;
  try {
    const result = await runPiTask({
      task: taskDescription,
      systemPrompt: buildHarnessSystemPrompt({ soul: sm.getContent(), contextSnapshot }),
      models: harnessModels(config),
      cwd,
      signal: controller?.signal,
      timeoutMs,
      id: specialistId,
    });
    return { text: result.text, hitMaxSteps: false, modelUsed: result.modelUsed };
  } finally {
    if (specialistId) cancellationRegistry.unregister(specialistId);
  }
}
