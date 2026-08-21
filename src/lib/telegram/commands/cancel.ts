import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { turnCancellation, type TurnCancelMode } from '../../agent/cancellation';
import { isOwner } from '../state';

const NOTHING_RUNNING = "💤 Nothing running to cancel.";

/** Words that mean "don't wait for the current step" on `/cancel <arg>`. */
const FORCE_WORDS = new Set(['now', 'force', 'hard', '!', 'kill']);

const forceKeyboard = new InlineKeyboard().text('⏹ Force stop', 'cancel_force');

/**
 * `/cancel` — interrupt the turn currently running in this chat.
 *
 * Two behaviours, because neither alone is right:
 *
 *  - **Graceful (default)** — flags the turn; the executor finishes the tool
 *    call already in flight, then stops and has the model summarise what it
 *    got done and what it left half-finished. Costs one cheap aux call and a
 *    wait bounded by the running tool, and leaves the conversation coherent.
 *  - **Force** (`/cancel now`, the inline button, or a second `/cancel`) —
 *    aborts the model call outright, and cascades into any specialists the
 *    turn spawned. Instant, but whatever the current step was doing is lost.
 *
 * Graceful is the default because the common case is "I changed my mind", not
 * "this is wedged" — and a summary of the abandoned work is what makes the
 * next message make sense. Force is one tap away for when a tool is hanging
 * and waiting for it is exactly the problem.
 */
export async function handleCancelCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;
  if (!isOwner(ctx.message?.from?.id)) return;

  const arg = (ctx.match as string | undefined)?.trim().toLowerCase();
  const mode: TurnCancelMode = arg && FORCE_WORDS.has(arg) ? 'force' : 'graceful';

  const outcome = turnCancellation.request(chatId, mode);

  if (outcome.status === 'none') {
    await ctx.reply(NOTHING_RUNNING);
    return;
  }

  if (outcome.status === 'force') {
    await ctx.reply(
      outcome.escalated
        ? '⏹ Escalating — stopping immediately.'
        : '⏹ Stopping immediately.',
    );
    return;
  }

  await ctx.reply(
    '⏹ Stopping after the current step — I’ll summarise what got done.\n' +
      '<i>Send /cancel again (or tap below) to drop it immediately instead.</i>',
    { parse_mode: 'HTML', reply_markup: forceKeyboard },
  );
}

/** Inline "⏹ Force stop" button on the graceful-cancel acknowledgement. */
export async function handleCancelCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || ctx.callbackQuery?.data !== 'cancel_force') return;
  if (!isOwner(ctx.callbackQuery.from?.id)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const outcome = turnCancellation.request(chatId, 'force');
  await ctx.answerCallbackQuery(outcome.status === 'none' ? '💤 Already finished' : '⏹ Stopping');
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
}
