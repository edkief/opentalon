import { configManager } from '../config';
import type { MemoryScope } from '../memory';

// Per-chatId Promise chain — serializes all agent calls so job callbacks never
// race with active message processing for the same chat.
const chatQueues = new Map<string, Promise<void>>();

// Per-chat model pin set by /setmodel — overrides config primary + fallbacks.
// Cleared by /resetmodel or process restart.
export const chatModelPins = new Map<string, string>();

/** Serialize a task behind any prior task queued for the same chat. */
export function enqueueForChat(chatId: string, task: () => Promise<void>): void {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch((e) => console.error('[Queue]', e))
    .finally(() => {
      if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
    });
  chatQueues.set(chatId, next);
}

/** Returns the current tool allowlist from config (re-read on every call for hot reload). */
export function getToolAllowlist(): Set<string> | '*' {
  const cfg = configManager.get().tools;
  const val = cfg?.allowlist ?? process.env.TOOL_ALLOWLIST?.trim();
  if (!val) return new Set();
  if (val === '*') return '*';
  if (Array.isArray(val)) return new Set(val);
  return new Set(String(val).split(',').map((s) => s.trim()).filter(Boolean));
}

/** Returns true if the sender is the configured owner (or no owner is configured). */
export function isOwner(userId?: number): boolean {
  const ownerId = configManager.get().telegram?.ownerId ?? process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) return true;
  return String(userId) === String(ownerId);
}

export function getScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
}
