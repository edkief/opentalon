// Vendored from edkief/ralph@82dc5a5 src/harness/events.ts and src/harness/types.ts (MIT).
// Adapted for OpenTalon: the form and permission events, the event-file history header and the
// AgentHarness interface are left out. The permission event returns with the pi gate (#70).
import { z } from 'zod';

/**
 * The harness event vocabulary: what a harness adapter (pi today) emits, whatever its own wire
 * format. A harness's wire format stops at its adapter; consumers (specialist execution, the
 * thought stream) read only this.
 *
 * Every event is `{ type, created?, session?, ...fields }`: `created` is epoch milliseconds, and
 * `session` the harness session the event belongs to. Fields a harness cannot supply are absent,
 * never invented.
 */

const Base = z.object({
  created: z.number().optional(),
  session: z.string().optional(),
});

/** What one model call used. Zero where the harness does not report a figure. */
export const StepUsageSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  /** Thinking tokens, where the harness counts them apart from `output`. */
  reasoning: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  /** What the provider's prices make the call cost, in dollars; 0 for models without prices. */
  cost: z.number().default(0),
});

export type StepUsage = z.infer<typeof StepUsageSchema>;

export const emptyStepUsage = (): StepUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export const HarnessEventSchema = z.discriminatedUnion('type', [
  /** A session opened. `parent` is set when the harness says whose child it is. */
  Base.extend({ type: z.literal('session.started'), session: z.string(), parent: z.string().optional() }),
  /** A prompt reached the agent. */
  Base.extend({ type: z.literal('prompt.queued'), text: z.string() }),

  /** `part` names a text or reasoning part across its deltas and end; absent when the harness gives none. */
  Base.extend({ type: z.literal('text.delta'), part: z.string().optional(), text: z.string() }),
  Base.extend({ type: z.literal('text.ended'), part: z.string().optional(), text: z.string() }),
  Base.extend({ type: z.literal('reasoning.delta'), part: z.string().optional(), text: z.string() }),
  /** `text` is absent when the reasoning is empty or not readable. */
  Base.extend({ type: z.literal('reasoning.ended'), part: z.string().optional(), text: z.string().optional() }),

  /** The agent begins a tool call. */
  Base.extend({ type: z.literal('tool.started'), id: z.string(), name: z.string().optional() }),
  /** The call's input is complete and the tool runs. `name` is that of `tool.started` with the same `id`, where there was one. */
  Base.extend({
    type: z.literal('tool.called'),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    /** The id of the call that made this one, as a codemode script does; absent for the agent's own calls. */
    parent: z.string().optional(),
  }),
  /** `output` is the tool's text, parts joined by newlines. A tool that ran and exited non-zero is `success` with its `exit`. */
  Base.extend({
    type: z.literal('tool.finished'),
    id: z.string().optional(),
    name: z.string().optional(),
    parent: z.string().optional(),
    status: z.enum(['success', 'error']),
    exit: z.number().optional(),
    output: z.string().optional(),
  }),

  /** A model call begins; `model` is `provider/id`. */
  Base.extend({ type: z.literal('step.started'), model: z.string().optional() }),
  /** The model's output stream is complete; tools may still run. */
  Base.extend({ type: z.literal('step.streamed') }),
  Base.extend({
    type: z.literal('step.ended'),
    finish: z.string().optional(),
    usage: StepUsageSchema.default(emptyStepUsage),
    files: z.array(z.string()).optional(),
  }),
  /** A model call failed, e.g. because the request overflowed the context window. */
  Base.extend({ type: z.literal('step.failed'), error: z.string().optional() }),
  /** The provider failed and the harness will try again. */
  Base.extend({
    type: z.literal('retry'),
    attempt: z.number().optional(),
    error: z.string().optional(),
    status: z.number().optional(),
  }),

  Base.extend({ type: z.literal('compaction.started') }),
  /** Compaction is still going. */
  Base.extend({ type: z.literal('compaction.progress') }),
  Base.extend({ type: z.literal('compaction.ended') }),

  /** The session's work ended. `error` is the reason, when it did not succeed. */
  Base.extend({
    type: z.literal('execution.ended'),
    outcome: z.enum(['succeeded', 'failed', 'aborted']),
    error: z.string().optional(),
  }),

  /** The agent is alive and nothing else is to be recorded: a harness event with no content of its own. */
  Base.extend({ type: z.literal('activity') }),
]);

export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessEventType = HarnessEvent['type'];
export type EventOf<T extends HarnessEventType> = Extract<HarnessEvent, { type: T }>;

/**
 * Whether an event proves the agent is alive, for an inactivity watchdog. Nearly all do; not the
 * provider retries, which mean the agent is stuck, nor the bookkeeping about sessions.
 */
export function isActivityEvent(event: HarnessEvent): boolean {
  switch (event.type) {
    case 'retry':
    case 'session.started':
      return false;
    default:
      return true;
  }
}

/**
 * A harness refused a request. `status` keeps the meaning of an HTTP status whatever the
 * transport: 404 the thing is gone, 409 it is already settled, 400 the request does not fit, any
 * other 4xx is final, and a 5xx may be retried.
 */
export class HarnessError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
