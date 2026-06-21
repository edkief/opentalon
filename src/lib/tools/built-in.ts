import type { ToolSet } from 'ai';
import type { BuiltInToolsOpts } from './types';
import { getSchedulingTools } from './scheduling';
import { getTerminalTools } from './terminal';
import { getSkillTools } from './skills';
import { getWebTools } from './web';
import { getMemoryTools } from './memory';
import { getBrowserTools } from './browser';
import { getWorkflowTools } from './workflows';
import { getTodoTools } from './todos';
import { getAgentTools } from './agents';
import { getCommunicationTools } from './communication';
import { getFileTools } from './files';
import { getCodeSearchTools } from './code-search';
import { getNotebookTools } from './notebook';
import { getTalonpressTools } from './talonpress';

export type { BuiltInToolsOpts } from './types';
export { getWorkspaceDir, listSkills, getSkillsSummary, invalidateSkillsCache } from './skills';

export function getBuiltInTools(opts?: BuiltInToolsOpts): ToolSet {
  return {
    ...getTerminalTools(opts),
    ...getCodeSearchTools(opts),
    ...getNotebookTools(opts),
    ...getSkillTools(opts),
    ...getWebTools(),
    ...getMemoryTools(opts),
    ...getWorkflowTools(opts),
    ...getBrowserTools(opts),
    ...getTodoTools(opts),
    ...getAgentTools(opts),
    ...getCommunicationTools(opts),
    ...getFileTools(opts),
    ...getTalonpressTools(),
    ...(opts?.telegramChatId ? getSchedulingTools(opts.telegramChatId) : {}),
  };
}
