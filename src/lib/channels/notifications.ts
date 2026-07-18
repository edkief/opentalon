/**
 * Channel-neutral notification listeners.
 *
 * These deliver workflow-outcome notifications and guidance ("user-input")
 * prompts to whichever chat triggered them, routed through the channel registry
 * (`sendToChat`). They were previously wired inside Telegram's `setupHandlers`
 * (`src/lib/telegram/handlers.ts`), which meant a Telegram-off deployment got no
 * workflow/guidance notifications at all. Moving them here decouples them from
 * the bot lifecycle: `setupChannelNotifications()` is called unconditionally
 * from `src/instrumentation.ts`.
 *
 * grammY `InlineKeyboard` reply markup is attached only for numeric (Telegram)
 * chatIds; other channels (email) get the options rendered as plain text.
 */

import { InlineKeyboard } from 'grammy';
import { and, eq } from 'drizzle-orm';
import { logBus } from '../agent/log-bus';
import type { WorkflowEvent, UserInputRequestEvent } from '../agent/log-bus';
import { db } from '../db';
import { failUserInput } from '../db/user-inputs';
import { workflowHitlRequests, workflows } from '../db/schema';
import { escapeHtml } from '../telegram/format';
import { sendToChat } from './registry';

const isTelegram = (chatId: string): boolean => /^-?\d+$/.test(chatId);

export function setupChannelNotifications(): void {
  const g = globalThis as typeof globalThis & { __channelNotificationsSetup?: boolean };
  if (g.__channelNotificationsSetup) return;
  g.__channelNotificationsSetup = true;

  // Deliver workflow outcome notifications to the triggering chat.
  logBus.on('workflow', async (event: WorkflowEvent) => {
    try {
      if (event.kind === 'hitl_requested' && event.runId && event.nodeId) {
        const [req] = await db
          .select()
          .from(workflowHitlRequests)
          .where(
            and(
              eq(workflowHitlRequests.runId, event.runId),
              eq(workflowHitlRequests.nodeId, event.nodeId),
              eq(workflowHitlRequests.status, 'pending'),
            ),
          )
          .limit(1);
        if (!req?.chatId) return;

        const body = `📋 <b>Workflow approval needed</b>\n\n${escapeHtml(req.prompt)}`;
        if (isTelegram(req.chatId)) {
          const keyboard = new InlineKeyboard()
            .text('✅ Approve', `workflow_hitl_approve:${req.id}`)
            .text('❌ Deny', `workflow_hitl_deny:${req.id}`);
          await sendToChat(req.chatId, body, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
          // Non-Telegram channels have no inline keyboard; approvals on other
          // channels are resolved via the dashboard.
          await sendToChat(
            req.chatId,
            `${body}\n\nApprove or deny this from the dashboard.`,
            { parse_mode: 'HTML' },
          );
        }
        return;
      }

      if (!event.chatId || event.chatId === 'system') return;

      if (event.kind === 'run_completed') {
        const [wf] = await db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, event.workflowId)).limit(1);
        const name = wf?.name ?? event.workflowId;
        const resultLine = event.result ? `\n\n${escapeHtml(event.result.slice(0, 800))}` : '';
        await sendToChat(event.chatId, `✅ <b>Workflow completed</b>: ${escapeHtml(name)}${resultLine}`, { parse_mode: 'HTML' });
        return;
      }

      if (event.kind === 'run_failed') {
        const [wf] = await db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, event.workflowId)).limit(1);
        const name = wf?.name ?? event.workflowId;
        const errorLine = event.errorMessage ? `\n\nError: ${escapeHtml(event.errorMessage.slice(0, 500))}` : '';
        await sendToChat(event.chatId, `❌ <b>Workflow failed</b>: ${escapeHtml(name)}${errorLine}`, { parse_mode: 'HTML' });
        return;
      }
    } catch (err) {
      console.error('[ChannelNotify] Failed to send workflow notification:', err);
    }
  });

  // Deliver guidance ("user-input") prompts to the requesting chat.
  logBus.on('user-input', async (event: UserInputRequestEvent) => {
    const { inputId, chatId, prompt, options } = event;
    try {
      if (options && options.length > 0 && isTelegram(chatId)) {
        // Telegram: inline keyboard. callback_data carries the option INDEX,
        // not the option text — Telegram caps callback_data at 64 bytes and the
        // guidance_<uuid>_ prefix alone is 46, so any real option text blows the
        // limit (400: BUTTON_DATA_INVALID). The callback handler resolves the
        // index back to the text via the stored user_inputs row.
        const keyboard = new InlineKeyboard();
        options.forEach((opt, i) => {
          const label = opt.length > 60 ? `${opt.slice(0, 59)}…` : opt;
          keyboard.text(label, `guidance_${inputId}_${i}`).row();
        });
        await sendToChat(chatId, `🤔 <b>Guidance needed</b>\n\n${prompt}`, { reply_markup: keyboard }, true);
      } else if (options && options.length > 0) {
        // Non-Telegram: no inline keyboard — render options as plain text so the
        // user can reply with one of them.
        await sendToChat(
          chatId,
          `🤔 <b>Guidance needed</b>\n\n${prompt}\n\nReply with one of: ${options.join(' / ')}`,
          undefined,
          true,
        );
      } else {
        // Free-text guidance request (behavior identical to the old handlers.ts).
        await sendToChat(chatId, `🤔 <b>Guidance needed</b>\n\n${prompt}\n\n<i>Please reply with your guidance.</i>`, undefined, true);
      }
    } catch (err) {
      // Surface the failure to the waiting request_guidance poll loop so the
      // agent learns delivery failed instead of silently timing out.
      console.error('[ChannelNotify] Failed to send guidance prompt:', err);
      const message = err instanceof Error ? err.message : String(err);
      await failUserInput(inputId, message).catch((dbErr) =>
        console.error('[ChannelNotify] Failed to mark guidance input as failed:', dbErr),
      );
    }
  });
}
