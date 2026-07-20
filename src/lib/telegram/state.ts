import { configManager } from '../config';
import type { MemoryScope } from '../memory';

// Per-chatId Promise chain — serializes all agent calls so job callbacks never
// race with active message processing for the same chat.
const chatQueues = new Map<string, Promise<void>>();

// Per-chat model pin set by /setmodel — overrides config primary + fallbacks.
// Cleared by /resetmodel or process restart.
export const chatModelPins = new Map<string, string>();

// Per-chat memory-scope override set by /scope — forces where recalled memories
// persist regardless of chat type (e.g. keep a 1-1 DM's memories 'shared').
// Cleared by /scope auto, /reset, or process restart.
export const chatScopeOverrides = new Map<string, MemoryScope>();

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

/** Returns true if the sender is one of the configured owners (or no owner is configured). */
export function isOwner(userId?: number): boolean {
  const configured = configManager.get().telegram?.ownerId;
  const owners: string[] =
    configured == null
      ? (process.env.TELEGRAM_OWNER_ID?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])
      : (Array.isArray(configured) ? configured : [configured]).map(String);
  if (owners.length === 0) return true; // no owner configured → allow all
  return owners.includes(String(userId));
}

/** The memory scope implied by the chat type, before any /scope override. */
export function getDefaultScope(chatType: string): MemoryScope {
  return chatType === 'private' ? 'private' : 'shared';
}

/**
 * Effective memory scope for a chat: an explicit /scope override if one is set,
 * otherwise the chat-type default (private DM / shared group). Pass chatId to
 * honour the override; omit it for the raw chat-type default.
 */
export function getScope(chatType: string, chatId?: string): MemoryScope {
  if (chatId) {
    const override = chatScopeOverrides.get(chatId);
    if (override) return override;
  }
  return getDefaultScope(chatType);
}
