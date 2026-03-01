import { type MiddlewareFn, type Context } from 'grammy';

/**
 * Middleware to determine if the current chat is a private message
 */
export const isPrivateMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const chat = ctx.chat;
  const isPrivate = chat?.type === 'private';
  await next();
};

/**
 * Middleware to determine if the current chat is a group or supergroup
 */
export const isGroupMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const chat = ctx.chat;
  const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';
  await next();
};

/**
 * Check if the bot was mentioned in a group message
 */
export function wasMentioned(ctx: Context): boolean {
  const message = 'message' in ctx ? ctx.message : undefined;
  const text = message?.text;
  if (!text) return false;

  const username = ctx.me.username;
  if (!username) return false;

  // Check for @mention
  const mentionRegex = new RegExp(`@${username}`, 'i');
  if (mentionRegex.test(text)) return true;

  return false;
}
