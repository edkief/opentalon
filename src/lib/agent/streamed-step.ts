import { streamText } from 'ai';
import type { GenerateTextResult } from 'ai';
import { emitStepLive } from './log-bus';
import type { StepEvent, StepPhase, StepStage } from './log-bus';

/**
 * Progressive step streaming.
 *
 * The AI SDK's `onStepFinish` only fires once a step (including its tool
 * execution) is fully complete, so reasoning, response text, tool calls and
 * tool results all surface at once. To display a step as it forms — thinking →
 * responding (calls pending) → done — we drive `streamText`'s `fullStream` and
 * emit the two EARLY stages here, while the caller's `onStepFinish` still emits
 * the authoritative final ('done') stage with the same `id`.
 *
 * Because every emit of a step shares one `id` (the deterministic step id),
 * the live thought stream replaces the row in place. These early stages are
 * LIVE-ONLY (emitStepLive) and never persisted; the caller's `onStepFinish`
 * persists the single final 'done' step, so the DB is identical to the classic
 * path and all same-step consumers are unaffected.
 */
export interface ProgressiveStepMeta {
  sessionId: string;
  agentId?: string;
  specialistId?: string;
  turnId?: string;
  phase: StepPhase;
  model: string;
  /** Deterministic per-step id, shared with the caller's 'done' emit. */
  makeStepId: (stepIndex: number) => string;
}

/** Subset of GenerateTextResult the executor reads after generation. */
type StreamedResult = Pick<
  GenerateTextResult<any, any>,
  'text' | 'steps' | 'usage' | 'totalUsage' | 'finishReason'
>;

/**
 * Runs `streamText`, emits the 'thinking' and 'responding' stages off the
 * fullStream, and resolves to a generateText-compatible result once the stream
 * drains. The caller's `onStepFinish` (passed in `args`) still runs and must
 * emit the final 'done' stage using the same `makeStepId`.
 */
export async function runStreamedGeneration(
  args: Parameters<typeof streamText>[0],
  meta: ProgressiveStepMeta,
): Promise<StreamedResult> {
  const result = streamText(args);

  let stepIndex = 0;
  let reasoning = '';
  let text = '';
  let toolCalls: { toolName: string; input: unknown }[] = [];
  let emittedResponding = false;

  const emitStage = (stage: StepStage): void => {
    const event: StepEvent = {
      id: meta.makeStepId(stepIndex),
      stage,
      sessionId: meta.sessionId,
      timestamp: new Date().toISOString(),
      stepIndex,
      finishReason: '',
      text: text || undefined,
      reasoning: reasoning.trim() || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      agentId: meta.agentId,
      specialistId: meta.specialistId,
      turnId: meta.turnId,
      phase: meta.phase,
      model: meta.model,
    };
    emitStepLive(event);
  };

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step':
        stepIndex += 1;
        reasoning = '';
        text = '';
        toolCalls = [];
        emittedResponding = false;
        break;
      case 'reasoning-delta':
        reasoning += part.text;
        break;
      case 'reasoning-end':
        // Stage 2a: thinking is complete and ready to show on its own.
        if (reasoning.trim()) emitStage('thinking');
        break;
      case 'text-delta':
        text += part.text;
        break;
      case 'tool-call':
        toolCalls.push({
          toolName: part.toolName,
          input: (part as any).input ?? (part as any).args,
        });
        break;
      case 'tool-result':
      case 'tool-error':
        // Stage 2b: by the first result, all of this step's tool calls are known
        // and their results are pending — show the response with pending calls.
        if (!emittedResponding && toolCalls.length) {
          emitStage('responding');
          emittedResponding = true;
        }
        break;
      case 'error': {
        // streamText surfaces failures as a stream part rather than throwing.
        // Re-throw so the executor's fallback chain still engages.
        const err = (part as any).error;
        throw err instanceof Error ? err : new Error(String(err));
      }
      case 'abort': {
        // Preserve the AbortError name so the executor skips fallbacks.
        const err = new Error('Generation aborted');
        err.name = 'AbortError';
        throw err;
      }
      default:
        break;
    }
  }

  // Stream drained → the buffered getters resolve without re-iterating.
  const [resolvedText, steps, usage, totalUsage, finishReason] = await Promise.all([
    result.text,
    result.steps,
    result.usage,
    result.totalUsage,
    result.finishReason,
  ]);

  return { text: resolvedText, steps, usage, totalUsage, finishReason };
}
