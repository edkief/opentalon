'use client';

import React from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  BackgroundVariant,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Bot, ChevronDown, ChevronRight, CircleUser, Loader2, MessageSquare, Wrench,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { NODE_W } from './turn-graph';
import { messageRoleLabel } from '@/lib/utils';
import type {
  MessageNodeData, SpecialistNodeData, StepNodeData, ToolNodeData,
} from './turn-graph';

// Status → border treatment, matching WorkflowCanvas conventions.
const SPEC_STATUS_BORDER: Record<string, string> = {
  running: 'border-blue-500 shadow-blue-500/20 shadow-md',
  complete: 'border-green-500',
  error: 'border-red-500',
  cancelled: 'border-red-500 opacity-70',
  max_steps: 'border-amber-400 shadow-amber-400/20 shadow-md',
};

const SPEC_STATUS_DOT: Record<string, string> = {
  running: 'bg-blue-400 animate-pulse',
  complete: 'bg-green-500',
  error: 'bg-red-500',
  cancelled: 'bg-red-500',
  max_steps: 'bg-amber-400',
};

const HANDLE_STYLE: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#6b7280',
  border: '2px solid white',
  opacity: 0.7,
};

function SpineHandles({ branch = false }: { branch?: boolean }) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
      {branch && (
        <Handle
          type="source"
          id="branch"
          position={Position.Right}
          style={HANDLE_STYLE}
          isConnectable={false}
        />
      )}
    </>
  );
}

function BranchTargetHandle() {
  return <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />;
}

function selectedRing(selected: boolean | undefined): string {
  return selected ? 'ring-2 ring-ring ring-offset-1 ring-offset-background' : '';
}

// ─── Message node (amber user / sky assistant — thought-stream colors) ────────

function MessageNode({ data, selected }: NodeProps) {
  const { message } = data as MessageNodeData;
  const isUser = message.role === 'user';
  return (
    <>
      <SpineHandles />
      <div
        style={{ width: NODE_W }}
        className={[
          'rounded-lg border-2 px-3 py-2 cursor-pointer select-none',
          isUser
            ? 'bg-amber-50 border-amber-300 dark:bg-amber-950/40 dark:border-amber-700'
            : 'bg-sky-50 border-sky-300 dark:bg-sky-950/40 dark:border-sky-700',
          selectedRing(selected),
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5 mb-1">
          {isUser
            ? <CircleUser className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            : <MessageSquare className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400 shrink-0" />}
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${isUser ? 'text-amber-700 dark:text-amber-400' : 'text-sky-700 dark:text-sky-400'}`}>
            {messageRoleLabel(message.role, message.agentId)}
          </span>
          <span className="ml-auto text-[9px] text-muted-foreground">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <p className="text-[11px] text-foreground leading-snug line-clamp-3 break-words">
          {message.content}
        </p>
      </div>
    </>
  );
}

// ─── Step node ────────────────────────────────────────────────────────────────

function StepNode({ data, selected }: NodeProps) {
  const { step, isLatest } = data as StepNodeData;
  const failed = !!step.errorMessage;
  const hasBranches = (step.toolCalls?.length ?? 0) > 0;
  return (
    <>
      <SpineHandles branch={hasBranches} />
      <div
        style={{ width: NODE_W }}
        className={[
          'rounded-lg border-2 bg-card px-3 py-2 cursor-pointer select-none',
          failed
            ? 'border-red-500'
            : isLatest
              ? 'border-blue-500 shadow-blue-500/20 shadow-md'
              : 'border-violet-300 dark:border-violet-800',
          selectedRing(selected),
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[10px] font-semibold text-violet-700 dark:text-violet-300">
            step {step.stepIndex}
          </span>
          <span className="text-[9px] text-muted-foreground">{step.finishReason}</span>
          {isLatest && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
          <span className="ml-auto text-[9px] text-muted-foreground tabular-nums">
            {step.durationMs !== undefined ? `${(step.durationMs / 1000).toFixed(1)}s` : ''}
          </span>
        </div>
        {failed ? (
          <p className="text-[10px] text-red-600 dark:text-red-400 line-clamp-2 break-words">
            {step.errorMessage}
          </p>
        ) : step.text ? (
          <p className="text-[10px] text-muted-foreground line-clamp-2 break-words">{step.text}</p>
        ) : hasBranches ? (
          <p className="text-[10px] text-muted-foreground italic">
            {step.toolCalls!.length} tool call{step.toolCalls!.length > 1 ? 's' : ''} →
          </p>
        ) : (
          <p className="text-[10px] text-muted-foreground italic">(no output)</p>
        )}
        {(step.reasoning || step.inputTokens !== undefined) && (
          <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground/70">
            {step.reasoning && step.reasoning !== '[object Object]' && (
              <span className="text-purple-600 dark:text-purple-400">thinking</span>
            )}
            {step.inputTokens !== undefined && (
              <span className="tabular-nums">{step.inputTokens}↑ {step.outputTokens ?? 0}↓</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Tool node ────────────────────────────────────────────────────────────────

function inputPreview(input: unknown): string {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function ToolNode({ data, selected }: NodeProps) {
  const tool = data as ToolNodeData;
  const pending = tool.output === undefined;
  return (
    <>
      <BranchTargetHandle />
      <div
        style={{ width: NODE_W }}
        className={[
          'rounded-lg border-2 bg-card px-3 py-2 cursor-pointer select-none',
          tool.isError ? 'border-red-500' : pending ? 'border-blue-400' : 'border-border',
          selectedRing(selected),
        ].join(' ')}
      >
        <div className="flex items-center gap-1.5">
          <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="text-[11px] font-mono font-medium truncate">{tool.toolName}</span>
          <span className="ml-auto shrink-0">
            {tool.isError
              ? <XCircle className="h-3.5 w-3.5 text-red-500" />
              : pending
                ? <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
          </span>
        </div>
        <p className="text-[9px] font-mono text-muted-foreground truncate mt-0.5">
          {inputPreview(tool.input)}
        </p>
      </div>
    </>
  );
}

// ─── Specialist node (collapsed card / expanded group) ───────────────────────

function SpecialistNode({ data, selected }: NodeProps) {
  const { summary, expanded, loading } = data as SpecialistNodeData;
  const border = SPEC_STATUS_BORDER[summary.status] ?? 'border-border';
  const dot = SPEC_STATUS_DOT[summary.status] ?? 'bg-muted';

  const header = (
    <div className="flex items-center gap-1.5">
      <Bot className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
      <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">
        specialist
      </span>
      {summary.background && (
        <span className="text-[9px] rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1">bg</span>
      )}
      <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} />
      <span className="text-[9px] text-muted-foreground">{summary.status}</span>
      <span className="ml-auto text-[9px] text-muted-foreground tabular-nums">
        {summary.durationMs !== undefined ? `${(summary.durationMs / 1000).toFixed(1)}s` : ''}
      </span>
      <button
        type="button"
        className="nodrag nopan flex items-center gap-0.5 text-[10px] text-indigo-600 dark:text-indigo-300 hover:underline shrink-0"
        data-expand-specialist={summary.specialistId}
        onClick={(e) => e.stopPropagation()}
        title={expanded ? 'Collapse steps' : 'Expand steps'}
      >
        {loading
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        {expanded ? 'collapse' : 'steps'}
      </button>
    </div>
  );

  if (expanded) {
    // Sized group container — children (its internal steps) render on top.
    return (
      <>
        <BranchTargetHandle />
        <div
          className={[
            'w-full h-full rounded-xl border-2 bg-indigo-50/40 dark:bg-indigo-950/20 px-3 py-2 cursor-pointer',
            border,
            selectedRing(selected),
          ].join(' ')}
        >
          {header}
          <p className="text-[10px] text-foreground/80 line-clamp-1 break-words mt-1">
            {summary.taskDescription}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <BranchTargetHandle />
      <div
        style={{ width: NODE_W }}
        className={[
          'rounded-xl border-2 bg-indigo-50/60 dark:bg-indigo-950/30 px-3 py-2 cursor-pointer select-none',
          border,
          selectedRing(selected),
        ].join(' ')}
      >
        {header}
        <p className="text-[10px] text-foreground leading-snug line-clamp-2 break-words mt-1">
          {summary.taskDescription}
        </p>
        {summary.result && (
          <p className="text-[9px] text-muted-foreground line-clamp-1 break-words mt-0.5">
            → {summary.result}
          </p>
        )}
      </div>
    </>
  );
}

const NODE_TYPES = {
  turnMessage: MessageNode,
  turnStep: StepNode,
  turnTool: ToolNode,
  turnSpecialist: SpecialistNode,
};

// ─── Canvas ───────────────────────────────────────────────────────────────────

const MINIMAP_COLORS: Record<string, string> = {
  turnMessage: '#f59e0b',
  turnStep: '#8b5cf6',
  turnTool: '#94a3b8',
  turnSpecialist: '#6366f1',
};

interface TurnCanvasProps {
  nodes: Node[];
  edges: import('@xyflow/react').Edge[];
  onNodeClick?: (event: React.MouseEvent, node: Node) => void;
  onPaneClick?: () => void;
  /** Called when a specialist node's expand/collapse button is clicked. */
  onToggleSpecialist?: (specialistId: string) => void;
}

/**
 * Read-only React Flow canvas for the turn deep-dive view. Must be rendered
 * inside WorkflowProvider (hoist to page level, same as WorkflowCanvas).
 */
export function TurnCanvas({ nodes, edges, onNodeClick, onPaneClick, onToggleSpecialist }: TurnCanvasProps) {
  const { fitView } = useReactFlow();
  const fittedRef = React.useRef(false);

  React.useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return;
    fittedRef.current = true;
    requestAnimationFrame(() => fitView({ padding: 0.15, maxZoom: 1 }));
  }, [nodes, fitView]);

  // Expand buttons stopPropagation so they never select the node. We catch
  // them in the capture phase (which runs before that) via event delegation,
  // keeping the node components decoupled from page state.
  const handleCanvasClickCapture = React.useCallback(
    (e: React.MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-expand-specialist]');
      const id = btn?.getAttribute('data-expand-specialist');
      if (id) onToggleSpecialist?.(id);
    },
    [onToggleSpecialist],
  );

  return (
    <div className="w-full h-full" onClickCapture={handleCanvasClickCapture}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="opacity-30" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => MINIMAP_COLORS[n.type ?? ''] ?? '#94a3b8'}
          className="!bg-card !border-border hidden md:block"
        />
      </ReactFlow>
    </div>
  );
}
