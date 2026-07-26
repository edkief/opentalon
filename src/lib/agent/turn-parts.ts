import type { ModelMessage } from 'ai';

/**
 * Helpers for persisting and replaying a turn's tool activity.
 *
 * Each assistant turn's AI SDK `response.messages` (assistant tool-call parts
 * + tool-result messages) are stored on the assistant conversation row
 * (`conversations.parts`) and replayed into the model prompt on later turns.
 * Without this, history collapses to plain text and the model sees its own
 * past turns as prose claims ("I edited the file") with no tool calls —
 * which teaches it in-context that narrating work without calling tools is
 * normal.
 */

type ContentPart = { type?: string; toolCallId?: string; [key: string]: unknown };

function contentParts(message: { content: unknown }): ContentPart[] | null {
  return Array.isArray(message.content) ? (message.content as ContentPart[]) : null;
}

/** True when an assistant message carries no tool calls — only text/reasoning. */
function isPlainTextAssistant(message: ModelMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (typeof message.content === 'string') return true;
  const parts = contentParts(message);
  return !!parts && parts.every((p) => p.type === 'text' || p.type === 'reasoning');
}

/**
 * Prepares a turn's `response.messages` for persistence:
 * - drops the trailing plain-text assistant message — the row's `content`
 *   (the text actually delivered, possibly amended by finalise/todo-check)
 *   is replayed as the trailing assistant text instead;
 * - strips provider-specific `reasoning` parts so replay stays valid when a
 *   fallback model from another provider handles the next turn.
 *
 * Returns undefined when nothing beyond plain text remains (no tool
 * activity), so text-only turns persist exactly as before.
 */
export function buildTurnParts(
  responseMessages: ModelMessage[] | undefined,
): unknown[] | undefined {
  if (!responseMessages?.length) return undefined;

  let messages = [...responseMessages];
  while (messages.length && isPlainTextAssistant(messages[messages.length - 1])) {
    messages = messages.slice(0, -1);
  }

  const cleaned = messages.flatMap((m) => {
    if (m.role !== 'assistant') return [m];
    const parts = contentParts(m);
    if (!parts) return [m];
    const kept = parts.filter((p) => p.type !== 'reasoning');
    if (kept.length === 0) return [];
    return [{ ...m, content: kept } as ModelMessage];
  });

  return cleaned.length ? cleaned : undefined;
}

/**
 * Minimal input shape for {@link toModelMessages} — both the in-memory
 * `Message` type and raw DB `NewConversation` rows satisfy this.
 */
export interface ToModelMessageInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** AI SDK response.messages for assistant rows; ignored for user/system. */
  parts?: unknown[];
}

/**
 * Maps a stored message row (or `Message`) into the AI SDK `ModelMessage[]`
 * shape the LLM prompt expects.
 *
 * Assistant rows with persisted `parts` have their tool-call/tool-result
 * parts replayed ahead of the trailing text so the model sees its past tool
 * activity, not just prose claims about it. Rows without parts (or with
 * malformed parts) fall back to plain text. User/system rows pass through.
 */
export function toModelMessages(m: ToModelMessageInput): ModelMessage[] {
  switch (m.role) {
    case 'system': return [{ role: 'system', content: m.content }];
    case 'assistant': {
      if (m.parts?.length) {
        try {
          const parts = sanitizeParts(m.parts);
          if (parts.length) return [...parts, { role: 'assistant', content: m.content }];
        } catch (err) {
          console.warn('[turn-parts] Failed to replay message parts, falling back to text:', err);
        }
      }
      return [{ role: 'assistant', content: m.content }];
    }
    case 'user': return [{ role: 'user', content: m.content }];
  }
}

/**
 * Validates parts loaded from the DB before replay. Providers reject
 * assistant tool-calls without a matching tool-result and vice versa, so
 * keep only tool-call/tool-result pairs whose `toolCallId` appears on both
 * sides. Per-turn atomic storage means this should never trim anything in
 * practice; it makes corrupt or legacy data non-fatal.
 */
export function sanitizeParts(raw: unknown): ModelMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages = raw.filter(
    (m): m is ModelMessage =>
      !!m && typeof m === 'object' &&
      ((m as ModelMessage).role === 'assistant' || (m as ModelMessage).role === 'tool'),
  );

  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const p of contentParts(m) ?? []) {
      if (!p.toolCallId) continue;
      if (m.role === 'assistant' && p.type === 'tool-call') callIds.add(p.toolCallId);
      if (m.role === 'tool') resultIds.add(p.toolCallId);
    }
  }
  const validIds = new Set([...callIds].filter((id) => resultIds.has(id)));

  return messages.flatMap((m) => {
    const parts = contentParts(m);
    if (!parts) return m.role === 'tool' ? [] : [m];
    const kept = parts.filter((p) => {
      const isToolPart = (m.role === 'assistant' && p.type === 'tool-call') || m.role === 'tool';
      return !isToolPart || (!!p.toolCallId && validIds.has(p.toolCallId));
    });
    if (kept.length === 0) return [];
    return [{ ...m, content: kept } as ModelMessage];
  });
}
