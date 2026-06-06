import { NextRequest, NextResponse } from 'next/server';
import { llmExecutor } from '@/lib/agent';
import { isChatText } from '@/lib/agent/types';
import { addMessage, getConversationHistory, getActiveAgent } from '@/lib/db';
import type { Message } from '@/lib/agent/types';
import { getBuiltInTools, getRegisteredTools, getWorkspaceDir, getSkillsSummary } from '@/lib/tools';
import { createSpecialistTools } from '@/lib/agent/specialist';
import { resolveApproval } from '@/lib/agent/hitl';
import { agentRegistry } from '@/lib/soul';
import { configManager } from '@/lib/config';
import type { ToolSet } from 'ai';

export const dynamic = 'force-dynamic';

const WEB_CHAT_ID = 'web';

function getToolAllowlist(): Set<string> | '*' {
  const cfg = configManager.get().tools;
  const val = cfg?.allowlist ?? process.env.TOOL_ALLOWLIST?.trim();
  if (!val) return new Set();
  if (val === '*') return '*';
  if (Array.isArray(val)) return new Set(val);
  return new Set(String(val).split(',').map((s) => s.trim()).filter(Boolean));
}

async function buildWebTools(chatId: string, agentId: string, turnJobIds: Set<string>): Promise<ToolSet> {
  const toolAllowlist = getToolAllowlist();
  const agentCfg = agentRegistry.getSoulManager(agentId).getConfig();

  // Auto-approve allowlisted tools; silently deny dangerous ones (no interactive UI in web chat)
  const sendApprovalRequest = async (approvalId: string, toolName: string): Promise<void> => {
    const allowed = toolAllowlist === '*' || toolAllowlist.has(toolName);
    setImmediate(() => resolveApproval(approvalId, allowed));
  };

  const [builtInTools, mcpTools] = await Promise.all([
    Promise.resolve(getBuiltInTools({
      sendApprovalRequest,
      telegramChatId: chatId,
      memoryScope: 'private',
      sendTelegramMessage: async (_chatId: string, _text: string) => {},
      allowedSkills: agentCfg.allowedSkills ?? null,
      allowedWorkflows: agentCfg.allowedWorkflows ?? null,
    })),
    getRegisteredTools({ sendApprovalRequest }),
  ]);

  const merged = { ...builtInTools, ...mcpTools };

  const agentToolFilter = agentCfg.tools;
  const mcpToolNames = new Set(Object.keys(mcpTools));
  const allTools: ToolSet =
    agentToolFilter && agentToolFilter.length > 0
      ? Object.fromEntries(
          Object.entries(merged).filter(([k]) => (agentToolFilter as string[]).includes(k) || mcpToolNames.has(k)),
        )
      : merged;

  const specialistTools = createSpecialistTools(0, allTools, chatId, agentId, undefined, turnJobIds);

  return { ...allTools, ...specialistTools };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, context, chatId: rawChatId, agentId: rawAgentId } = body as {
      message?: string;
      context?: string;
      chatId?: string;
      agentId?: string;
    };

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const chatId = rawChatId?.trim() || WEB_CHAT_ID;
    const agentId = rawAgentId?.trim() || await getActiveAgent(chatId);

    const turnJobIds = new Set<string>();

    const [tools, history, skillsSummary] = await Promise.all([
      buildWebTools(chatId, agentId, turnJobIds),
      getConversationHistory(chatId, agentId, 20),
      getSkillsSummary(),
    ]);

    const messages: Message[] = [
      ...history.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { role: 'user', content: message },
    ];

    const turnId = crypto.randomUUID();

    await addMessage(chatId, 0, 'user', message, agentId, undefined, turnId);

    const skillsContext = skillsSummary
      ? `\n\nAvailable skills (use skill_get to read full instructions before running):\n${skillsSummary}`
      : '\n\nNo skills saved yet.';

    const response = await llmExecutor.chat({
      messages,
      context: context ?? `Web chat. Agent workspace: ${getWorkspaceDir()} (use this as the base for all file paths). Skills are stored in ${getWorkspaceDir()}/skills/.${skillsContext}`,
      chatId,
      memoryScope: 'private',
      agentId,
      tools,
      turnJobIds,
      turnId,
    });

    if (!isChatText(response)) {
      return NextResponse.json({ error: 'No response generated' }, { status: 500 });
    }

    await addMessage(chatId, 0, 'assistant', response.text, agentId, undefined, response.turnId ?? turnId);

    return NextResponse.json({ text: response.text, chatId });
  } catch (error) {
    console.error('[Chat API] Error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('[Config]')) {
      return NextResponse.json({ error: 'Configuration invalid', detail: msg }, { status: 503 });
    }
    return NextResponse.json({ error: 'Failed to generate response' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Chat API endpoint. POST with { message, chatId? }',
  });
}
