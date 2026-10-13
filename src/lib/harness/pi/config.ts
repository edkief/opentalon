import { join } from 'node:path';
import { configManager } from '../../config';

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type PiThinking = (typeof PI_THINKING_LEVELS)[number];

/** `harness.pi` from config.yaml with its defaults filled in. */
export interface PiHarnessConfig {
  enabled: boolean;
  binary: string;
  thinking?: PiThinking;
  trustProject: boolean;
  args: string[];
  /** Where pi writes its session files. */
  sessionDir: string;
}

/** The workspace agent tools run in; the same fallback chain as the skills tools. */
function agentWorkspace(): string {
  return configManager.get().tools?.agentWorkspace ?? process.env.AGENT_WORKSPACE ?? process.cwd();
}

/** Read `harness.pi` fresh each call, so a config hot-reload applies to the next pi process. */
export function resolvePiConfig(): PiHarnessConfig {
  const pi = configManager.get().harness?.pi;
  return {
    enabled: pi?.enabled ?? false,
    binary: pi?.binary ?? 'pi',
    thinking: pi?.thinking,
    trustProject: pi?.trustProject ?? false,
    args: pi?.args ?? [],
    sessionDir: pi?.sessionDir ?? join(agentWorkspace(), '.harness', 'pi', 'sessions'),
  };
}
