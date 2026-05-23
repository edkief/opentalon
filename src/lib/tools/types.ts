export type ApprovalCallback = (approvalId: string, toolName: string, input: unknown) => Promise<void>;

export interface BuiltInToolsOpts {
  sendApprovalRequest?: ApprovalCallback;
  telegramChatId?: string;
  memoryScope?: 'private' | 'shared';
  sendTelegramMessage?: (chatId: string, text: string, format: 'html' | 'markdown') => Promise<void>;
  allowedSkills?: string[] | null;
  allowedWorkflows?: string[] | null;
  allowedSubAgents?: string[] | null;
}
