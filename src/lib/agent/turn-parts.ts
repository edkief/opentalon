import type { ModelMessage } from 'ai';
import { truncateText } from '../db/pg-safe';

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
 *   (the text actually delivered, possibly replaced by finalise/todo-check)
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
 * activity, not just prose claims about it. Tool outputs are capped for replay
 * ({@link capReplayedOutputs}). Rows without parts (or with malformed parts)
 * fall back to plain text. User/system rows pass through.
 */
export function toModelMessages(m: ToModelMessageInput): ModelMessage[] {
  switch (m.role) {
    case 'system': return [{ role: 'system', content: m.content }];
    case 'assistant': {
      if (m.parts?.length) {
        try {
          const parts = capReplayedOutputs(sanitizeParts(m.parts));
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

// ─── Replay size cap (#85) ───────────────────────────────────────────────────

/** Most of one tool output replayed from an earlier turn, in characters. */
export const REPLAY_OUTPUT_LIMIT = 2_000;
/** Most tool output replayed from one earlier turn, in characters. */
export const REPLAY_TURN_LIMIT = 20_000;
/** Below this, an output gets a one-line stub instead of a useless sliver. */
const REPLAY_MIN_SLICE = 200;

type ReplayOutput = { type?: string; value?: unknown; [key: string]: unknown };

/** The text an output contributes to the prompt, or null for shapes left alone. */
function outputText(output: ReplayOutput): string | null {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return typeof output.value === 'string' ? output.value : null;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value ?? null);
    case 'content':
      return Array.isArray(output.value) ? JSON.stringify(output.value) : null;
    default:
      return null; // execution-denied, legacy or unknown shapes
  }
}

/** Plain text for a cut `content` output: its text items, with media counted up front. */
function contentText(value: unknown[]): string {
  const items = value as Array<{ type?: string; text?: unknown }>;
  const text = items
    .filter((i) => i?.type === 'text' && typeof i.text === 'string')
    .map((i) => i.text as string)
    .join('\n');
  const media = items.length - items.filter((i) => i?.type === 'text').length;
  // Leading, so a cut that follows can't drop it.
  return media > 0 ? `[${media} media part${media === 1 ? '' : 's'} omitted]\n${text}` : text;
}

function cutOutput(output: ReplayOutput, allowance: number): ReplayOutput {
  const isError = output.type === 'error-text' || output.type === 'error-json';
  const type = isError ? 'error-text' : 'text';
  const full =
    output.type === 'content' ? contentText(output.value as unknown[])
    : output.type === 'json' || output.type === 'error-json' ? JSON.stringify(output.value ?? null)
    : (output.value as string);
  const value =
    allowance < REPLAY_MIN_SLICE
      ? `[output omitted from replay: ${full.length} chars]`
      : full.length <= allowance
        ? full
        : `${truncateText(full, allowance)}\n[… cut for replay: showing ${allowance} of ${full.length} chars]`;
  return { type, value };
}

/**
 * Bounds how much tool output an earlier turn puts into later prompts (#85).
 * Each output keeps at most {@link REPLAY_OUTPUT_LIMIT} characters, and the turn
 * at most {@link REPLAY_TURN_LIMIT}, spent newest first: the last results of a
 * long run matter most, so the oldest are the ones reduced to a stub. Cut
 * outputs say so. Only `output` values change — no part is dropped — so
 * call/result pairs stay matched. A turn within both limits is returned as is.
 * The stored row keeps everything; this applies at replay only.
 */
export function capReplayedOutputs(messages: ModelMessage[]): ModelMessage[] {
  const sizes = new Map<ContentPart, number>();
  let total = 0;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const p of contentParts(m) ?? []) {
      if (p.type !== 'tool-result' || !p.output || typeof p.output !== 'object') continue;
      const text = outputText(p.output as ReplayOutput);
      if (text === null) continue;
      sizes.set(p, text.length);
      total += text.length;
    }
  }
  const oversized = [...sizes.values()].some((n) => n > REPLAY_OUTPUT_LIMIT);
  if (!oversized && total <= REPLAY_TURN_LIMIT) return messages;

  const replaced = new Map<ContentPart, ContentPart>();
  let remaining = REPLAY_TURN_LIMIT;
  for (const [part, size] of [...sizes].reverse()) {
    const allowance = Math.min(REPLAY_OUTPUT_LIMIT, remaining);
    if (size <= allowance) {
      remaining -= size;
      continue;
    }
    const output = cutOutput(part.output as ReplayOutput, allowance);
    remaining -= Math.min(allowance, (output.value as string).length);
    replaced.set(part, { ...part, output });
  }

  return messages.map((m) => {
    if (m.role !== 'tool') return m;
    const parts = contentParts(m);
    if (!parts?.some((p) => replaced.has(p))) return m;
    return { ...m, content: parts.map((p) => replaced.get(p) ?? p) } as ModelMessage;
  });
}
