import type { EventOf, HarnessEvent, StepUsage } from '../harness/events';
import { TOOL_OUTPUT_LIMIT } from './log-bus';
import type { StepEvent, StepStage, ToolPermission } from './log-bus';

/**
 * Harness runs in the thought stream (#69): folds a harness's event stream (../harness/events.ts)
 * into the StepEvents a native specialist emits, one per model call, so a pi run reads in the
 * thought stream, the turn canvas and metrics like a native one.
 *
 * A pi model call ends before the tools it asked for run, so a step is done only when the next
 * call starts or the execution ends; in between it is in the `tools` stage. With progressive
 * steps on, the earlier stages are emitted live under the step's id, as streamed-step.ts does;
 * only `done` steps are persisted. Retries, compactions, failed calls and a run that ends badly
 * become steps of their own (finishReason `retry`, `compaction`, `error`, `aborted`), persisted
 * like any other, so they are never silently dropped. What the permission gate (#70) decides
 * about a call is kept on the call (`permission`): `asked` while it waits, then the decision.
 *
 * Pure: the caller routes `persist` steps to emitStep and the rest to emitStepLive.
 */

export interface FoldedStep {
  event: StepEvent;
  /** A `done` step (persist with emitStep); else a live-only progressive stage (emitStepLive). */
  persist: boolean;
}

export interface HarnessStepMeta {
  specialistId: string;
  /** The thread the specialist's steps hang off, as for a native specialist. */
  threadId?: string;
  harness: 'pi';
  /** `llm.progressiveSteps`: emit the thinking/responding/tools stages live. */
  progressive: boolean;
  now?: () => number;
}

interface OpenStep {
  n: number;
  startedAt: number;
  model?: string;
  text: string[];
  textDelta: string;
  reasoning: string[];
  reasoningDelta: string;
  toolCalls: { id?: string; toolName: string; input: unknown; permission?: ToolPermission }[];
  toolResults: { toolName: string; output: string; isError?: boolean }[];
  ended?: EventOf<'step.ended'>;
  /** A live stage went out under this step's id. */
  shown: boolean;
}

export class HarnessStepFolder {
  private readonly now: () => number;
  private open: OpenStep | undefined;
  private index = 0;
  private lastError: string | undefined;

  constructor(private readonly meta: HarnessStepMeta) {
    this.now = meta.now ?? Date.now;
  }

  push(event: HarnessEvent): FoldedStep[] {
    switch (event.type) {
      case 'step.started': {
        const out = this.close();
        this.open = this.newStep(event.created, event.model);
        return out;
      }
      case 'text.delta':
        this.current(event.created).textDelta += event.text;
        return [];
      case 'text.ended': {
        const step = this.current(event.created);
        step.text.push(event.text);
        step.textDelta = '';
        return this.stage('responding');
      }
      case 'reasoning.delta':
        this.current(event.created).reasoningDelta += event.text;
        return [];
      case 'reasoning.ended': {
        const step = this.current(event.created);
        const text = event.text ?? step.reasoningDelta;
        step.reasoningDelta = '';
        if (!text.trim()) return [];
        step.reasoning.push(text);
        return this.stage('thinking');
      }
      case 'tool.started': {
        const step = this.current(event.created);
        step.toolCalls.push({ id: event.id, toolName: event.name ?? 'tool', input: undefined });
        return this.stage('responding');
      }
      case 'tool.called': {
        const step = this.current(event.created);
        const known = event.id ? step.toolCalls.find((call) => call.id === event.id) : undefined;
        if (known) {
          known.input = event.input;
          if (event.name) known.toolName = event.name;
        } else {
          step.toolCalls.push({ id: event.id, toolName: event.name ?? 'tool', input: event.input });
        }
        return this.stage('tools');
      }
      case 'tool.finished': {
        const step = this.current(event.created);
        const name = event.name ?? step.toolCalls.find((call) => call.id === event.id)?.toolName ?? 'tool';
        const output = (event.output ?? '').slice(0, TOOL_OUTPUT_LIMIT);
        step.toolResults.push(event.status === 'error' ? { toolName: name, output, isError: true } : { toolName: name, output });
        return this.stage('tools');
      }
      case 'permission.asked':
        return this.permit(event.call, { decision: 'asked' });
      case 'permission.decided':
        return this.permit(event.call, { decision: event.decision, ...(event.reason ? { reason: event.reason } : {}) });
      case 'step.ended': {
        const step = this.current(event.created);
        step.ended = event;
        // Tools asked for in this call run next: show them as running. Without any, the step is done at the next event.
        return step.toolCalls.length > 0 ? this.stage('tools') : [];
      }
      case 'step.failed': {
        const error = event.error ?? 'the model call failed';
        if (this.open && !this.open.ended) return this.close({ finishReason: 'error', errorMessage: error });
        return [...this.close(), this.marker('error', `pi: the model call failed: ${error}`, error)];
      }
      case 'retry': {
        const error = event.error ?? 'provider error';
        const attempt = event.attempt !== undefined ? ` (attempt ${event.attempt})` : '';
        // The attempt that failed: shown only when it got anywhere, as its error is the retry's.
        const out = this.isEmpty(this.open) ? this.discard() : this.close({ finishReason: 'error', errorMessage: error });
        // Only a failed call right before the end stands in for the run's failure.
        this.lastError = undefined;
        return [...out, this.marker('retry', `pi is retrying after a provider error${attempt}: ${error}`)];
      }
      case 'compaction.started':
        return [...this.close(), this.marker('compaction', 'pi is compacting its context')];
      case 'execution.ended': {
        const fallback = event.outcome === 'succeeded' ? 'stop' : event.outcome === 'failed' ? 'error' : 'aborted';
        const out = this.close({ finishReason: fallback });
        if (event.outcome === 'failed') {
          const error = event.error ?? 'unknown error';
          // A failed call just before already says it.
          if (error !== this.lastError) out.push(this.marker('error', `pi run failed: ${error}`, error));
        } else if (event.outcome === 'aborted') {
          out.push(this.marker('aborted', 'pi stopped the run before it finished'));
        }
        return out;
      }
      default:
        return [];
    }
  }

  /**
   * Record the gate's word on a call of the open step. A call the gate cannot tie to one (a
   * malformed request) shows only in its tool result, where pi reports the block.
   */
  private permit(callId: string | undefined, permission: ToolPermission): FoldedStep[] {
    const call = callId ? this.open?.toolCalls.find((candidate) => candidate.id === callId) : undefined;
    if (!call) return [];
    call.permission = permission;
    return this.stage('tools');
  }

  /** Close the step still open, e.g. when the run is cancelled before pi reports its end. */
  finish(): FoldedStep[] {
    return this.close({ finishReason: 'aborted' });
  }

  private newStep(created: number | undefined, model?: string): OpenStep {
    return {
      n: ++this.index,
      startedAt: created ?? this.now(),
      model,
      text: [],
      textDelta: '',
      reasoning: [],
      reasoningDelta: '',
      toolCalls: [],
      toolResults: [],
      shown: false,
    };
  }

  /** The open step; content that arrives without a `step.started` opens one. */
  private current(created: number | undefined): OpenStep {
    this.open ??= this.newStep(created);
    return this.open;
  }

  private isEmpty(step: OpenStep | undefined): boolean {
    return !!step && !step.shown && !step.ended && !step.textDelta && !step.reasoningDelta
      && step.text.length === 0 && step.reasoning.length === 0 && step.toolCalls.length === 0;
  }

  /** Drop an open step that showed nothing, and give its index back. */
  private discard(): FoldedStep[] {
    if (this.open && this.open.n === this.index) this.index -= 1;
    this.open = undefined;
    return [];
  }

  private stage(stage: Exclude<StepStage, 'done'>): FoldedStep[] {
    if (!this.meta.progressive || !this.open) return [];
    this.open.shown = true;
    return [{ event: this.build(this.open, stage), persist: false }];
  }

  private close(fallback?: { finishReason: string; errorMessage?: string }): FoldedStep[] {
    const step = this.open;
    this.open = undefined;
    if (!step) return [];
    const event = this.build(step, this.meta.progressive ? 'done' : undefined);
    if (!step.ended && fallback) {
      event.finishReason = fallback.finishReason;
      if (fallback.errorMessage) {
        event.errorMessage = fallback.errorMessage;
        this.lastError = fallback.errorMessage;
      }
    }
    event.durationMs = Math.max(0, this.now() - step.startedAt);
    return [{ event, persist: true }];
  }

  private build(step: OpenStep, stage: StepStage | undefined): StepEvent {
    const text = [...step.text, step.textDelta].join('').trim();
    const reasoning = [...step.reasoning, step.reasoningDelta].join('\n').trim();
    return {
      id: this.stepId(step.n),
      ...(stage ? { stage } : {}),
      sessionId: this.meta.specialistId,
      threadId: this.meta.threadId,
      timestamp: new Date(this.now()).toISOString(),
      stepIndex: step.n,
      finishReason: step.ended?.finish ?? '',
      text: text || undefined,
      reasoning: reasoning || undefined,
      toolCalls: step.toolCalls.length > 0
        ? step.toolCalls.map(({ toolName, input, permission }) => ({ toolName, input, ...(permission ? { permission: { ...permission } } : {}) }))
        : undefined,
      toolResults: step.toolResults.length > 0 ? [...step.toolResults] : undefined,
      specialistId: this.meta.specialistId,
      phase: 'specialist',
      ...(step.ended ? usageFields(step.ended.usage) : {}),
      model: step.model,
      harness: this.meta.harness,
    };
  }

  /** A harness moment as a step of its own. */
  private marker(finishReason: string, text: string, errorMessage?: string): FoldedStep {
    const n = ++this.index;
    if (errorMessage) this.lastError = errorMessage;
    return {
      event: {
        id: this.stepId(n),
        ...(this.meta.progressive ? { stage: 'done' as const } : {}),
        sessionId: this.meta.specialistId,
        threadId: this.meta.threadId,
        timestamp: new Date(this.now()).toISOString(),
        stepIndex: n,
        finishReason,
        text,
        ...(errorMessage ? { errorMessage } : {}),
        specialistId: this.meta.specialistId,
        phase: 'specialist',
        harness: this.meta.harness,
      },
      persist: true,
    };
  }

  /** The id scheme of a native specialist's progressive steps (specialist.ts makeStepId). */
  private stepId(n: number): string {
    return `${this.meta.specialistId}:specialist:${n}`;
  }
}

/**
 * A harness's usage in OpenTalon's stored shape (usage.ts): `inputTokens` is the total input,
 * cache included, where pi counts the cached part apart; reasoning is already inside output.
 */
export function usageFields(usage: StepUsage): Pick<
  StepEvent,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'harnessCostUsd'
> {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...(usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {}),
    harnessCostUsd: usage.cost,
  };
}
