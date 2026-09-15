/**
 * Slash-command parsing, kept free of any DB/config import so a channel (or a
 * test) can ask "is this text a command?" without booting the world.
 *
 * The handler table in `./index.ts` is typed as `Record<ChatCommandName, …>`,
 * so a name added here without an implementation — or an implementation
 * without a name — is a compile error rather than a command that silently
 * parses into nothing.
 */
export const CHAT_COMMAND_NAMES = [
  'help',
  'start',
  'status',
  'reset',
  'new',
  'compact',
  'cancel',
  'refresh_skills',
  'listagents',
  'agent',
  'listmodels',
  'setmodel',
  'resetmodel',
  'scope',
] as const;

export type ChatCommandName = (typeof CHAT_COMMAND_NAMES)[number];

export interface ChatCommand {
  name: ChatCommandName;
  /** Everything after the command name, trimmed (may be empty). */
  args: string;
}

const NAMES: ReadonlySet<string> = new Set(CHAT_COMMAND_NAMES);

/**
 * Split `/name rest` into a command, or return null if the text isn't one.
 *
 * Only *known* commands are recognised. A message that merely starts with a
 * slash — an absolute path, a regex, a date — stays a message and reaches the
 * agent unchanged, which matters more on a channel people paste paths into
 * than the ability to catch a typo'd command name. `/name@botname` is accepted
 * so a transcript copied out of Telegram behaves the same here.
 */
export function parseChatCommand(text: string): ChatCommand | null {
  const match = /^\/([A-Za-z_][A-Za-z0-9_]*)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!NAMES.has(name)) return null;
  return { name: name as ChatCommandName, args: (match[2] ?? '').trim() };
}

export function isChatCommand(text: string): boolean {
  return parseChatCommand(text) !== null;
}
