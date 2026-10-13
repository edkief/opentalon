import { InlineKeyboard } from 'grammy';
import { resolveApproval } from '../agent/hitl';
import { getEmbedClient } from '../embed/config';
import { embedClientIdOf, isEmbedChatId } from '../embed/threads';
import { getBot } from '../telegram/send';
import { getToolAllowlist } from '../telegram/state';
import type { ApprovalCallback } from '../tools/types';
import { sendToChat } from './registry';

/**
 * An approval callback for a run with no channel context of its own — a background specialist
 * (pg-boss) or a resumed turn — that asks the chat the way that chat's channel asks in the
 * foreground:
 *
 *   - a tool `tools.allowlist` covers is approved at once (embed: only when the client's
 *     `dangerousTools` is `allowlist`);
 *   - a Telegram chat gets the Approve / Deny keyboard, resolved by the bot's callback handler;
 *   - any other chat (email, embed, web) is told the call was skipped, and it is denied, as
 *     those channels have no approval prompt.
 *
 * Resolutions are deferred with setImmediate: the caller registers waitForApproval() after this
 * returns.
 */
export function createChatApprover(chatId: string, label = 'background task'): ApprovalCallback {
  return async (approvalId, toolName, input) => {
    const allowlist = getToolAllowlist();
    const allowlisted = allowlist === '*' || allowlist.has(toolName);
    const embedClient = isEmbedChatId(chatId) ? getEmbedClient(embedClientIdOf(chatId) ?? '') : undefined;
    const autoApprove = allowlisted && (embedClient === undefined || embedClient?.dangerousTools === 'allowlist');
    if (autoApprove) {
      setImmediate(() => resolveApproval(approvalId, true));
      return;
    }

    const preview = JSON.stringify(input, null, 2).slice(0, 500);
    const bot = getBot();
    if (bot && /^-?\d+$/.test(chatId)) {
      const keyboard = new InlineKeyboard().text('✅ Approve', `approve:${approvalId}`).text('❌ Deny', `deny:${approvalId}`);
      try {
        await bot.api.sendMessage(chatId, `⚠️ Dangerous tool requested (${label})\n\nTool: ${toolName}\nInput:\n${preview}\n\nApprove this action?`, {
          reply_markup: keyboard,
        });
        return;
      } catch (err) {
        console.error('[Approval] Could not send the approval request; denying:', err);
        setImmediate(() => resolveApproval(approvalId, false));
        return;
      }
    }

    // No channel to ask on: say so, and deny rather than leave the run waiting.
    await sendToChat(
      chatId,
      `⚠️ **Dangerous tool requested** (${label})\n\n**Tool:** \`${toolName}\`\n**Input:**\n\`\`\`json\n${preview}\n\`\`\`\n\n` +
        `There is no approval prompt on this channel, so I skipped it. Allow it with tools.allowlist, or ask again from Telegram.`,
    ).catch((err) => console.error('[Approval] Could not post the approval notice:', err));
    setImmediate(() => resolveApproval(approvalId, false));
  };
}
