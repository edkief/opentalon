import { BotError, GrammyError, HttpError } from 'grammy';

/** Return the original middleware error when grammY wrapped it in a BotError. */
function unwrapBotError(error: unknown): unknown {
  return error instanceof BotError ? error.error : error;
}

/**
 * Extract a low-level network error code without logging the underlying fetch
 * error. Fetch errors may contain the full Telegram URL, including the bot
 * token, so callers should log telegramErrorSummary() instead of the object.
 */
function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current !== 'object') return undefined;

    const candidate = current as { code?: unknown; errno?: unknown; error?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    if (typeof candidate.errno === 'string') return candidate.errno;
    current = candidate.error ?? candidate.cause;
  }

  return undefined;
}

export function isTelegramConnectionError(error: unknown): boolean {
  return unwrapBotError(error) instanceof HttpError;
}

/** Only parsing/entity errors can be fixed by resending without formatting. */
export function isTelegramFormattingError(error: unknown): boolean {
  const cause = unwrapBotError(error);
  if (!(cause instanceof GrammyError) || cause.error_code !== 400) return false;

  return /(?:can't parse entities|can't find end of the entity|entity bounds|message entities)/i.test(
    cause.description,
  );
}

/** A concise, credential-safe description suitable for application logs. */
export function telegramErrorSummary(error: unknown): string {
  const cause = unwrapBotError(error);

  if (cause instanceof HttpError) {
    const method = /for '([^']+)'/.exec(cause.message)?.[1] ?? 'unknown';
    const code = networkErrorCode(cause);
    return `connection failure method=${method}${code ? ` code=${code}` : ''}`;
  }

  if (cause instanceof GrammyError) {
    return `API failure method=${cause.method} status=${cause.error_code} description=${cause.description}`;
  }

  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

export function logTelegramDeliveryFailure(context: string, error: unknown): void {
  console.warn(`[Telegram] ${context}: ${telegramErrorSummary(error)}`);
}
