export type ApprovalCallback = (approvalId: string, toolName: string, input: unknown) => Promise<void>;

export interface BuiltInToolsOpts {
  sendApprovalRequest?: ApprovalCallback;
  telegramChatId?: string;
  /**
   * Scope id for todo storage, distinct from the chat id. Lets specialists keep
   * their own isolated todo lists (scope = specialistId) so they never clobber or
   * surface in the main agent's chat-scoped list. Falls back to telegramChatId.
   */
  todoScopeId?: string;
  memoryScope?: 'private' | 'shared';
  sendTelegramMessage?: (chatId: string, text: string, format: 'html' | 'markdown') => Promise<void>;
  allowedSkills?: string[] | null;
  allowedWorkflows?: string[] | null;
  allowedSubAgents?: string[] | null;
}
