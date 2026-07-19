import type { ToolSet } from 'ai';
import type { BuiltInToolsOpts, ToolFamily, ToolProfile } from './types';
import { configManager } from '../config';
import { getSchedulingTools } from './scheduling';
import { getTerminalTools } from './terminal';
import { getSkillTools } from './skills';
import { getWebTools } from './web';
import { getMemoryTools } from './memory';
import { getHistoryTools } from './history';
import { getBrowserTools } from './browser';
import { getWorkflowTools } from './workflows';
import { getTodoTools } from './todos';
import { getAgentTools } from './agents';
import { getCommunicationTools } from './communication';
import { getFileTools } from './files';
import { getCodeSearchTools } from './code-search';
import { getNotebookTools } from './notebook';
import { getLspTools } from './lsp';
import { getTalonpressTools } from './talonpress';

export type { BuiltInToolsOpts } from './types';
export { getWorkspaceDir, listSkills, getSkillsSummary, invalidateSkillsCache } from './skills';

/**
 * Built-in tools grouped into families (#19 part 1). Each family is a builder
 * so tools are only instantiated for the families a request actually includes,
 * keeping the serialized tools array — the single biggest contributor to idle
 * context — as small as the selected profile.
 */
const TOOL_FAMILY_BUILDERS: Record<ToolFamily, (opts?: BuiltInToolsOpts) => ToolSet> = {
  terminal: (opts) => getTerminalTools(opts),
  'code-search': (opts) => getCodeSearchTools(opts),
  notebook: (opts) => getNotebookTools(opts),
  lsp: (opts) => getLspTools(opts),
  skills: (opts) => getSkillTools(opts),
  web: () => getWebTools(),
  memory: (opts) => ({ ...getMemoryTools(opts), ...getHistoryTools(opts) }),
  workflows: (opts) => getWorkflowTools(opts),
  browser: (opts) => getBrowserTools(opts),
  todos: (opts) => getTodoTools(opts),
  agents: (opts) => getAgentTools(opts),
  communication: (opts) => getCommunicationTools(opts),
  files: (opts) => getFileTools(opts),
  talonpress: () => getTalonpressTools(),
  scheduling: (opts) => (opts?.chatId ? getSchedulingTools(opts.chatId) : {}),
};

export const ALL_TOOL_FAMILIES = Object.keys(TOOL_FAMILY_BUILDERS) as ToolFamily[];

/** Minimal profile: enough to read/write files, run commands, and keep state. */
export const LEAN_TOOL_FAMILIES: ToolFamily[] = ['terminal', 'files', 'memory', 'todos'];

/**
 * Resolve a ToolProfile (per-agent override → global default → 'full') into a
 * concrete family list. Unknown family names in a custom array are dropped;
 * an empty result falls back to 'full' so a misconfigured profile never leaves
 * an agent with no tools.
 */
export function resolveToolFamilies(profile?: ToolProfile | string[]): ToolFamily[] {
  const p = profile ?? configManager.get().tools?.defaultProfile ?? 'full';
  if (p === 'lean') return LEAN_TOOL_FAMILIES;
  if (Array.isArray(p)) {
    const valid = p.filter((f): f is ToolFamily => (ALL_TOOL_FAMILIES as string[]).includes(f));
    return valid.length > 0 ? valid : ALL_TOOL_FAMILIES;
  }
  // 'full' or any unrecognised value
  return ALL_TOOL_FAMILIES;
}

export function getBuiltInTools(opts?: BuiltInToolsOpts): ToolSet {
  const families = resolveToolFamilies(opts?.toolProfile);
  const tools: ToolSet = {};
  for (const family of families) {
    Object.assign(tools, TOOL_FAMILY_BUILDERS[family](opts));
  }
  return tools;
}
