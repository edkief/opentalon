import type { ModelMessage } from 'ai';
import { loadChatSteps } from './orchestration-store';

/**
 * Rebuilds the tool activity a turn had already executed before a crash, as AI
 * SDK `ModelMessage`s, so a resumed turn can be handed its own prior work and
 * continue from there instead of redoing it.
 *
 * Source of truth is `conversation_steps` (persisted per-step, fire-and-forget,
 * keyed by turnId). For each completed step we emit:
 *   - an assistant message carrying that step's `tool-call` parts, then
 *   - a `tool` message carrying the matching `tool-result` parts.
 * Replaying the *results* — rather than re-invoking the tools — is the whole
 * point: side-effectful tools (run_command, memory writes, message sends) that
 * already ran must not run again; the model just needs to see what they returned.
 *
 * Limitations, by construction:
 *   - Only the `main` phase is reconstructed. Finalise / todo-check are cheap
 *     post-turn passes that re-run naturally once the main loop finishes.
 *   - Persisted steps store no `toolCallId` (see log-bus StepEvent), so we mint a
 *     deterministic synthetic id per (step, position) and use it on both sides of
 *     the pair — all the provider needs is that call and result ids match.
 *   - The single step that was mid-flight when the process died was never
 *     persisted (onStepFinish hadn't fired), so it is simply re-executed.
 *   - Reasoning/thinking blocks are dropped; they carry no tool state.
 *
 * Returns an empty array when there is no reconstructable tool activity — the
 * caller then falls back to restarting the turn from the original user message.
 */
export async function reconstructTurnMessages(
  turnId: string,
  chatId: string,
): Promise<{ messages: ModelMessage[]; executedSteps: number }> {
  const steps = (await loadChatSteps(chatId, undefined, undefined, [turnId]))
    .filter((s) => (s.phase ?? 'main') === 'main')
    .sort((a, b) => a.stepIndex - b.stepIndex);

  const messages: ModelMessage[] = [];
  let executedSteps = 0;

  for (const step of steps) {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    // A step with no tool calls is a pure-text/finish step; nothing to replay as
    // tool state (any text is superseded once the model continues).
    if (calls.length === 0) continue;

    const callParts: Array<{ type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
    const resultParts: Array<{
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'text'; value: string } | { type: 'error-text'; value: string };
    }> = [];

    calls.forEach((call, i) => {
      const toolCallId = `resume-${turnId}-${step.stepIndex}-${i}`;
      callParts.push({ type: 'tool-call', toolCallId, toolName: call.toolName, input: call.input ?? {} });
      // Pair results to calls positionally (steps persist them in call order).
      // A missing result — the crash landed between call and result — still needs
      // a matching tool-result part or the provider rejects the orphaned call, so
      // synthesize an explicit "interrupted" marker.
      const res = results[i];
      const value = res ? res.output : '[tool result unavailable — interrupted by restart]';
      resultParts.push({
        type: 'tool-result',
        toolCallId,
        toolName: res?.toolName ?? call.toolName,
        output: res?.isError ? { type: 'error-text', value } : { type: 'text', value },
      });
    });

    messages.push({ role: 'assistant', content: callParts } as ModelMessage);
    messages.push({ role: 'tool', content: resultParts } as ModelMessage);
    executedSteps++;
  }

  return { messages, executedSteps };
}
