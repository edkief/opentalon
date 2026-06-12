import { getTelegramEntities } from 'md-to-tg';
import type { MessageEntity } from 'md-to-tg';

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
export const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac', '.opus']);
export const VIDEO_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);

export const TELEGRAM_MAX_LENGTH = 4096;

/** Escape HTML entities for safe use in Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Parse GFM Markdown into plain text + Telegram MessageEntity array.
 * Using entities avoids all parse_mode escaping issues entirely.
 * Falls back to { text: original, entities: [] } on error.
 */
export function formatForTelegram(markdown: string): { text: string; entities: MessageEntity[] } {
  try {
    return getTelegramEntities(markdown);
  } catch (error) {
    console.warn('[Telegram] Entity parsing failed, sending as plain text:', error);
    return { text: markdown, entities: [] };
  }
}

/** Split raw markdown into chunks ≤ maxLen chars, never cutting inside a fenced code block. */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  // Find fenced code block ranges so we never cut inside them
  const codeBlockRanges: [number, number][] = [];
  const fenceRe = /^```/gm;
  let fenceMatch: RegExpExecArray | null;
  let openAt = -1;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    if (openAt === -1) {
      openAt = fenceMatch.index;
    } else {
      codeBlockRanges.push([openAt, fenceMatch.index + fenceMatch[0].length]);
      openAt = -1;
    }
  }
  const isInsideBlock = (pos: number): boolean =>
    codeBlockRanges.some(([s, e]) => pos > s && pos < e);

  const chunks: string[] = [];
  let remaining = text.trim();
  let offset = text.length - remaining.length;

  while (remaining.length > maxLen) {
    let splitAt = -1;
    for (const candidate of [
      remaining.lastIndexOf('\n\n', maxLen),
      remaining.lastIndexOf('\n', maxLen),
      remaining.lastIndexOf(' ', maxLen),
      maxLen,
    ]) {
      if (candidate <= 0) continue;
      if (!isInsideBlock(offset + candidate)) { splitAt = candidate; break; }
    }
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    const next = remaining.slice(splitAt).trim();
    offset += remaining.length - next.length;
    remaining = next;
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
