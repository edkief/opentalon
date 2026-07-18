export type ApprovalCallback = (approvalId: string, toolName: string, input: unknown) => Promise<void>;

/** Named group of related built-in tools (#19 part 1 — lean default profile). */
export type ToolFamily =
  | 'terminal'
  | 'code-search'
  | 'notebook'
  | 'lsp'
  | 'skills'
  | 'web'
  | 'memory'
  | 'workflows'
  | 'browser'
  | 'todos'
  | 'agents'
  | 'communication'
  | 'files'
  | 'talonpress'
  | 'scheduling';

/**
 * Selects which built-in tool families are injected into a request.
 * - 'full'  — every family (default; unchanged behaviour).
 * - 'lean'  — a minimal core (terminal, files, memory, todos).
 * - array   — an explicit list of families to include.
 * Resolvable globally (config tools.defaultProfile) and per-agent (SoulConfig
 * toolProfile), the latter winning.
 */
export type ToolProfile = 'full' | 'lean' | ToolFamily[];

export interface BuiltInToolsOpts {
  sendApprovalRequest?: ApprovalCallback;
  /** Channel-neutral conversation id (numeric telegram, 'web', or 'email:<hex>'). */
  chatId?: string;
  /**
   * Scope id for todo storage, distinct from the chat id. Lets specialists keep
   * their own isolated todo lists (scope = specialistId) so they never clobber or
   * surface in the main agent's chat-scoped list. Falls back to chatId.
   */
  todoScopeId?: string;
  memoryScope?: 'private' | 'shared';
  /** Active agent id — used to tag agent-authored RAG entries (memory_append store:'recall'). */
  agentId?: string;
  /**
   * Which tool families to include (#19 part 1). Undefined falls back to the
   * global config default (tools.defaultProfile), then 'full'. Pass the agent's
   * own toolProfile here to let a per-agent profile override the global default.
   * Accepts a loose string[] (from YAML config); unknown family names are
   * dropped during resolution.
   */
  toolProfile?: ToolProfile | string[];
  /** Channel-neutral outbound sender (registry sendToChat, or a channel-specific one). */
  sendMessage?: (chatId: string, text: string, format: 'html' | 'markdown') => Promise<void>;
  allowedSkills?: string[] | null;
  allowedWorkflows?: string[] | null;
  allowedSubAgents?: string[] | null;
}
