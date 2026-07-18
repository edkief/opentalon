export type ApprovalCallback = (approvalId: string, toolName: string, input: unknown) => Promise<void>;

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
  /** Channel-neutral outbound sender (registry sendToChat, or a channel-specific one). */
  sendMessage?: (chatId: string, text: string, format: 'html' | 'markdown') => Promise<void>;
  allowedSkills?: string[] | null;
  allowedWorkflows?: string[] | null;
  allowedSubAgents?: string[] | null;
}
