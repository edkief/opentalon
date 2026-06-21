import type { Edge, Node } from '@xyflow/react';
import type { SpecialistSummary, StepEvent } from '@/lib/agent/log-bus';
import { TODO_TOOL_NAMES } from '@/lib/agent/todo-utils';

/**
 * Latest todo tool result across a step list. Steps are chronological (API/run
 * order), and within a step toolResults preserve call order, so the last match
 * is the most recent todo state. Used to scope the inspector's todo panel to the
 * selected execution context (main agent = its turn steps; specialist = its own
 * run steps), since todos are now per-agent rather than per-chat.
 */
export function latestTodoSnapshot(
  steps: StepEvent[],
): { toolName: string; output: string } | undefined {
  let snapshot: { toolName: string; output: string } | undefined;
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      if (TODO_TOOL_NAMES.has(tr.toolName)) snapshot = { toolName: tr.toolName, output: tr.output };
    }
  }
  return snapshot;
}

// ─── Data shapes ──────────────────────────────────────────────────────────────

/** Conversation row as serialized by GET /api/turns/[turnId]. */
export interface TurnMessage {
  id: number;
  chatId: string;
  messageId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  agentId?: string | null;
  turnId?: string | null;
}

export interface TurnData {
  turnId: string;
  messages: TurnMessage[];
  steps: StepEvent[];
  specialists: SpecialistSummary[];
  systemPrompt?: string;
}

export interface MessageNodeData extends Record<string, unknown> {
  kind: 'message';
  message: TurnMessage;
}

export interface StepNodeData extends Record<string, unknown> {
  kind: 'step';
  step: StepEvent;
  /** True while the turn is still running and this is the latest step. */
  isLatest: boolean;
}

export interface ToolNodeData extends Record<string, unknown> {
  kind: 'tool';
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  /** Step the call belongs to (for the inspector breadcrumb). */
  stepId: string;
}

export interface SpecialistNodeData extends Record<string, unknown> {
  kind: 'specialist';
  summary: SpecialistSummary;
  expanded: boolean;
  /** Steps are being fetched (expand clicked, data not yet cached). */
  loading: boolean;
}

export type TurnNodeData = MessageNodeData | StepNodeData | ToolNodeData | SpecialistNodeData;

// ─── Layout constants (estimated node sizes; nodes render at fixed widths) ────

export const NODE_W = 280;
const H_MESSAGE = 96;
const H_STEP = 88;
const H_TOOL = 64;
const H_SPECIALIST = 104;
const GAP_Y = 32; // vertical gap between spine rows
const BRANCH_GAP_Y = 14; // vertical gap between stacked branch nodes
const BRANCH_X = NODE_W + 90; // branch column offset from the spine column
const GROUP_PAD = 16; // inner padding of an expanded specialist group
const GROUP_HEADER = 64; // header strip of an expanded specialist group

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface BranchEntry {
  kind: 'tool' | 'specialist';
  node: Node;
  height: number;
  /** Children of an expanded specialist group (already parented to `node`). */
  subNodes?: Node[];
  subEdges?: Edge[];
}

interface SubGraph {
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
}

function pairToolResults(step: StepEvent): (string | undefined)[] {
  // Pair toolCalls[i] with the i-th result of the same toolName, falling back
  // to plain index pairing when names don't line up.
  const used = new Set<number>();
  const results = step.toolResults ?? [];
  return (step.toolCalls ?? []).map((tc, i) => {
    const byName = results.findIndex((tr, j) => !used.has(j) && tr.toolName === tc.toolName);
    const idx = byName >= 0 ? byName : !used.has(i) && results[i] ? i : -1;
    if (idx < 0) return undefined;
    used.add(idx);
    return String(idx);
  });
}

function parseJobId(output: string | undefined): string | undefined {
  if (!output) return undefined;
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed.jobId === 'string' ? parsed.jobId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the branch entries (tool + specialist nodes) for one step.
 * spawn_specialist calls are replaced by specialist nodes when a matching run
 * exists; remaining specialists are claimed in spawn order via `unclaimed`.
 */
function buildBranches(
  step: StepEvent,
  unclaimed: SpecialistSummary[],
  byId: Map<string, SpecialistSummary>,
  ctx: BuildContext,
  idPrefix: string,
  parentId?: string,
): BranchEntry[] {
  const entries: BranchEntry[] = [];
  const resultIdx = pairToolResults(step);
  const results = step.toolResults ?? [];

  (step.toolCalls ?? []).forEach((tc, i) => {
    const ri = resultIdx[i];
    const result = ri !== undefined ? results[Number(ri)] : undefined;

    if (tc.toolName === 'spawn_specialist') {
      const jobId = parseJobId(result?.output);
      let summary = jobId ? byId.get(jobId) : undefined;
      if (summary && unclaimed.includes(summary)) {
        unclaimed.splice(unclaimed.indexOf(summary), 1);
      } else if (!summary) {
        summary = unclaimed.shift();
      }
      if (summary) {
        entries.push(makeSpecialistEntry(summary, ctx, parentId));
        return;
      }
      // No matching run (e.g. spawn failed before the run row was written) —
      // fall through and render the call as a plain tool node.
    }

    entries.push({
      kind: 'tool',
      height: H_TOOL,
      node: {
        id: `${idPrefix}tool:${step.id}:${i}`,
        type: 'turnTool',
        position: { x: 0, y: 0 },
        draggable: false,
        connectable: false,
        ...(parentId ? { parentId, extent: 'parent' as const } : {}),
        data: {
          kind: 'tool',
          toolName: tc.toolName,
          input: tc.input,
          output: result?.output,
          isError: result?.isError,
          stepId: step.id,
        } satisfies ToolNodeData,
      },
    });
  });

  return entries;
}

interface BuildContext {
  expanded: Set<string>;
  specialistSteps: Map<string, StepEvent[]>;
  specialists: SpecialistSummary[];
}

function makeSpecialistEntry(
  summary: SpecialistSummary,
  ctx: BuildContext,
  parentId?: string,
): BranchEntry {
  const isExpanded = ctx.expanded.has(summary.specialistId);
  const steps = ctx.specialistSteps.get(summary.specialistId);

  const base: Node = {
    id: `spec:${summary.specialistId}`,
    type: 'turnSpecialist',
    position: { x: 0, y: 0 },
    draggable: false,
    connectable: false,
    ...(parentId ? { parentId, extent: 'parent' as const } : {}),
    data: {
      kind: 'specialist',
      summary,
      expanded: isExpanded && !!steps,
      loading: isExpanded && !steps,
    } satisfies SpecialistNodeData,
  };

  if (!isExpanded || !steps) {
    return { kind: 'specialist', node: base, height: H_SPECIALIST };
  }

  // Expanded: the specialist node becomes a sized group containing its own spine.
  const inner = buildSpecialistInternals(summary, steps, ctx);
  base.style = { width: inner.width, height: inner.height };
  return {
    kind: 'specialist',
    node: base,
    height: inner.height,
    subNodes: inner.nodes,
    subEdges: inner.edges,
  };
}

/** Lays out a specialist's internal steps inside its group node. */
function buildSpecialistInternals(
  summary: SpecialistSummary,
  steps: StepEvent[],
  ctx: BuildContext,
): SubGraph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const groupId = `spec:${summary.specialistId}`;
  const idPrefix = '';

  // Sub-specialists spawned by this run, in spawn order.
  const children = ctx.specialists
    .filter((s) => s.parentSpecialistId === summary.specialistId)
    .sort((a, b) => new Date(a.spawnedAt).getTime() - new Date(b.spawnedAt).getTime());
  const childIds = new Map(children.map((s) => [s.specialistId, s]));
  const unclaimed = [...children];

  let y = GROUP_HEADER;
  let hasBranches = false;
  let prevId: string | undefined;

  for (const step of steps) {
    const stepNodeId = `step:${step.id}`;
    nodes.push({
      id: stepNodeId,
      type: 'turnStep',
      position: { x: GROUP_PAD, y },
      draggable: false,
      connectable: false,
      parentId: groupId,
      extent: 'parent',
      data: { kind: 'step', step, isLatest: false } satisfies StepNodeData,
    });
    if (prevId) {
      edges.push(spineEdge(prevId, stepNodeId));
    }
    prevId = stepNodeId;

    const branches = buildBranches(step, unclaimed, childIds, ctx, idPrefix, groupId);
    let branchY = y;
    for (const entry of branches) {
      hasBranches = true;
      entry.node.position = { x: GROUP_PAD + BRANCH_X, y: branchY };
      nodes.push(entry.node);
      if (entry.subNodes) {
        nodes.push(...entry.subNodes);
        edges.push(...(entry.subEdges ?? []));
      }
      edges.push(branchEdge(stepNodeId, entry.node.id));
      branchY += entry.height + BRANCH_GAP_Y;
    }

    const rowH = Math.max(H_STEP, branchY - y - (branches.length > 0 ? BRANCH_GAP_Y : 0));
    y += rowH + GAP_Y;
  }

  const width = GROUP_PAD * 2 + NODE_W + (hasBranches ? BRANCH_X - NODE_W + NODE_W : 0);
  return { nodes, edges, width, height: Math.max(y - GAP_Y + GROUP_PAD, H_SPECIALIST) };
}

function spineEdge(source: string, target: string, animated = false): Edge {
  return {
    id: `e:${source}->${target}`,
    source,
    target,
    animated,
    type: 'smoothstep',
  };
}

function branchEdge(source: string, target: string): Edge {
  return {
    id: `e:${source}->${target}`,
    source,
    target,
    sourceHandle: 'branch',
    animated: false,
    type: 'smoothstep',
    style: { strokeDasharray: '4 3' },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds the React Flow graph for one conversation turn.
 *
 * Pure: same inputs → same nodes/edges with deterministic ids, so selection
 * and expansion survive live refetches.
 */
export function buildTurnGraph(
  data: TurnData,
  expanded: Set<string>,
  specialistSteps: Map<string, StepEvent[]>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const ctx: BuildContext = { expanded, specialistSteps, specialists: data.specialists };

  const userMessages = data.messages.filter((m) => m.role === 'user');
  const assistantMessages = data.messages.filter((m) => m.role === 'assistant');
  // Exclude specialist steps — they belong to specialist sub-graphs, not the
  // main agent spine. Specialist steps carry a specialistId; main agent steps do not.
  const mainSteps = [...data.steps]
    .filter((s) => !s.specialistId)
    .sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() ||
        a.stepIndex - b.stepIndex,
    );

  // Turn-level specialists (no parent, or parent outside this turn's set).
  const allIds = new Set(data.specialists.map((s) => s.specialistId));
  const roots = data.specialists
    .filter((s) => !s.parentSpecialistId || !allIds.has(s.parentSpecialistId))
    .sort((a, b) => new Date(a.spawnedAt).getTime() - new Date(b.spawnedAt).getTime());
  const rootById = new Map(roots.map((s) => [s.specialistId, s]));
  const unclaimed = [...roots];

  const isRunning = assistantMessages.length === 0;

  let y = 0;
  let prevSpineId: string | undefined;

  for (const msg of userMessages) {
    const id = `msg:${msg.id}`;
    nodes.push({
      id,
      type: 'turnMessage',
      position: { x: 0, y },
      draggable: false,
      connectable: false,
      data: { kind: 'message', message: msg } satisfies MessageNodeData,
    });
    if (prevSpineId) edges.push(spineEdge(prevSpineId, id));
    prevSpineId = id;
    y += H_MESSAGE + GAP_Y;
  }

  // While the turn is running the user/assistant messages haven't been persisted
  // yet. For scheduled-task turns, synthesize a trigger node from the first root
  // specialist's taskDescription so the graph has a visible starting point.
  if (userMessages.length === 0 && roots.length > 0 && roots[0].taskDescription) {
    const synthId = `msg:trigger`;
    nodes.push({
      id: synthId,
      type: 'turnMessage',
      position: { x: 0, y },
      draggable: false,
      connectable: false,
      data: {
        kind: 'message',
        message: {
          id: -1,
          chatId: '',
          messageId: 0,
          role: 'user',
          content: `[Scheduled Task Triggered]\n\nTask: ${roots[0].taskDescription}`,
          createdAt: roots[0].spawnedAt,
        },
      } satisfies MessageNodeData,
    });
    if (prevSpineId) edges.push(spineEdge(prevSpineId, synthId));
    prevSpineId = synthId;
    y += H_MESSAGE + GAP_Y;
  }

  mainSteps.forEach((step, idx) => {
    const stepNodeId = `step:${step.id}`;
    nodes.push({
      id: stepNodeId,
      type: 'turnStep',
      position: { x: 0, y },
      draggable: false,
      connectable: false,
      data: {
        kind: 'step',
        step,
        isLatest: isRunning && idx === mainSteps.length - 1,
      } satisfies StepNodeData,
    });
    if (prevSpineId) edges.push(spineEdge(prevSpineId, stepNodeId, isRunning && idx === mainSteps.length - 1));
    prevSpineId = stepNodeId;

    const branches = buildBranches(step, unclaimed, rootById, ctx, '');
    let branchY = y;
    for (const entry of branches) {
      entry.node.position = { x: BRANCH_X, y: branchY };
      nodes.push(entry.node);
      if (entry.subNodes) {
        nodes.push(...entry.subNodes);
        edges.push(...(entry.subEdges ?? []));
      }
      edges.push(branchEdge(stepNodeId, entry.node.id));
      branchY += entry.height + BRANCH_GAP_Y;
    }

    const rowH = Math.max(H_STEP, branchY - y - (branches.length > 0 ? BRANCH_GAP_Y : 0));
    y += rowH + GAP_Y;
  });

  // Specialists that never matched a spawn tool call (e.g. pre-turnId data,
  // or steps not recorded): attach them to the last spine node.
  for (const summary of unclaimed) {
    const entry = makeSpecialistEntry(summary, ctx);
    entry.node.position = { x: BRANCH_X, y };
    nodes.push(entry.node);
    if (entry.subNodes) {
      nodes.push(...entry.subNodes);
      edges.push(...(entry.subEdges ?? []));
    }
    if (prevSpineId) edges.push(branchEdge(prevSpineId, entry.node.id));
    y += entry.height + GAP_Y;
  }

  for (const msg of assistantMessages) {
    const id = `msg:${msg.id}`;
    nodes.push({
      id,
      type: 'turnMessage',
      position: { x: 0, y },
      draggable: false,
      connectable: false,
      data: { kind: 'message', message: msg } satisfies MessageNodeData,
    });
    if (prevSpineId) edges.push(spineEdge(prevSpineId, id));
    prevSpineId = id;
    y += H_MESSAGE + GAP_Y;
  }

  return { nodes, edges };
}
