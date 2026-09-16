/**
 * The volatile system block: current time, active todos, and running background
 * specialists — the part of the system prompt that legitimately changes from
 * one step to the next within a single turn.
 *
 * Lives outside llm-executor.ts because it has to be re-rendered *per step*
 * (#55) rather than once per turn, which makes it a unit worth testing on its
 * own. Its counterpart, the stable block, is built in llm-executor and is
 * byte-identical for the whole turn so the provider prompt cache can key on it.
 */
import type { ModelMessage } from 'ai';
import { configManager } from '../config';
import { todoManager } from './todo-manager';
import { getRunningJobsForChat } from '../db/jobs';

/**
 * Renders the volatile block. Timestamp is minute-granularity — second
 * precision bought nothing and busted the prompt cache on every request.
 */
export async function buildVolatileSystem(chatId?: string): Promise<string> {
  const parts: string[] = [];
  const timezone = configManager.get().timezone ?? 'UTC';
  const localDatetime = new Date().toLocaleString('en-AU', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  parts.push(`## Current date & time\n${localDatetime} (${timezone})`);

  const todoSummary = chatId ? todoManager.getSummary(chatId) : '';
  if (todoSummary) parts.push(`\n\n## Active Todos\n${todoSummary}`);

  if (chatId) {
    try {
      const runningJobs = await getRunningJobsForChat(chatId);
      if (runningJobs.length > 0) {
        const jobLines = runningJobs
          .map((j) => `- \`${j.id}\` (${j.status}): ${j.taskDescription?.split('\n')[0]?.slice(0, 80) ?? 'task'}`)
          .join('\n');
        parts.push(`\n\n## Background Specialists In Progress\nThese specialists are currently running for this conversation — do NOT re-spawn or duplicate their work:\n${jobLines}`);
      }
    } catch {
      // Non-fatal: job lookup failure must not break system prompt generation.
    }
  }

  return parts.join('');
}

/**
 * Builds a per-step message rewriter that swaps the volatile system message for
 * a freshly rendered one.
 *
 * The AI SDK builds the outgoing message list once per generation and only
 * appends assistant/tool messages as steps run, so anything baked into the
 * system messages up front is frozen for the whole turn. That left the model
 * reading `- [ ] task` in the system prompt while its own tool history said the
 * task was done — a contradiction a smaller model resolves by re-issuing the
 * same `todo_update` forever (#55). `prepareStep` is the supported escape
 * hatch: returning `messages` overrides the list for that step.
 *
 * Two details worth keeping:
 *  - We rewrite the message in place rather than returning `prepareStep`'s
 *    `system` field. That field defaults to the top-level `system` *option*,
 *    which the executor never passes (both system blocks live in `messages` so
 *    the cache breakpoint can sit on exactly the stable one) — returning it
 *    would append a third system block rather than replace ours.
 *  - The target is found by content match against what we last emitted, not by
 *    index, so it survives any future reordering of the message list.
 *
 * The stable system message is untouched, so the prompt-cache prefix stays
 * byte-identical across steps.
 *
 * @param initial  the volatile block as first sent, used to locate it
 * @param chatId   todo/job scope
 * @param suffix   appended verbatim after the rebuilt block (the deferred-tool
 *                 family directory, which is computed once per turn)
 * @returns a function returning the rewritten list, or `undefined` when there
 *          is nothing to change — letting the caller leave `messages` alone.
 */
export function makeVolatileRefresh(initial: string, chatId?: string, suffix = '') {
  let current = initial;
  return async (messages: ModelMessage[]): Promise<ModelMessage[] | undefined> => {
    const index = messages.findIndex((m) => m.role === 'system' && m.content === current);
    if (index === -1) return undefined; // not found — leave the list alone
    const rebuilt = await buildVolatileSystem(chatId);
    const next = suffix ? `${rebuilt}\n\n${suffix}` : rebuilt;
    if (next === current) return undefined; // unchanged; keep the array identity
    current = next;
    const updated = [...messages];
    updated[index] = { role: 'system', content: next };
    return updated;
  };
}
