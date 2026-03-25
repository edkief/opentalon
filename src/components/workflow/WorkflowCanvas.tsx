'use client';

import React, { useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type IsValidConnection,
  BackgroundVariant,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { X } from 'lucide-react';
import {
  Bot, GitMerge, GitBranch, ShieldCheck, ArrowRightFromLine, ArrowRightToLine, Code2,
} from 'lucide-react';

// ─── Shared constants ─────────────────────────────────────────────────────────

export const NODE_TYPE_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  input:     { label: 'Input',     icon: ArrowRightFromLine, color: 'bg-emerald-500/15 border-emerald-500/50' },
  output:    { label: 'Output',    icon: ArrowRightToLine,   color: 'bg-violet-500/15 border-violet-500/50' },
  agent:     { label: 'Agent',     icon: Bot,                color: 'bg-sky-500/15 border-sky-500/50' },
  parallel:  { label: 'Parallel',  icon: GitMerge,           color: 'bg-orange-500/15 border-orange-500/50' },
  condition: { label: 'Condition', icon: GitBranch,          color: 'bg-yellow-500/15 border-yellow-500/50' },
  hitl:      { label: 'Approval',  icon: ShieldCheck,        color: 'bg-rose-500/15 border-rose-500/50' },
  code:      { label: 'Code',      icon: Code2,              color: 'bg-slate-500/15 border-slate-500/50' },
};

export const NODE_STATUS_COLOR: Record<string, string> = {
  waiting:       'border-border',
  running:       'border-blue-500 shadow-blue-500/20 shadow-md',
  completed:     'border-green-500',
  failed:        'border-red-500',
  skipped:       'border-border opacity-50',
  awaiting_hitl: 'border-amber-400 shadow-amber-400/20 shadow-md',
};

const HANDLE_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#6b7280',
  border: '2px solid white',
};

const DEFAULT_EDGE_OPTIONS = { animated: true, type: 'deletable' };

// ─── Deletable edge — shows an × button at midpoint on hover ─────────────────

function DeletableEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, markerEnd, style, label,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const { setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
          className="absolute pointer-events-auto nodrag nopan flex flex-col items-center gap-1"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {label && (
            <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground leading-none shadow-sm">
              {label as string}
            </span>
          )}
          <button
            style={{ background: 'hsl(var(--destructive))', color: 'hsl(var(--destructive-foreground))' }}
            className={`flex items-center justify-center w-4 h-4 rounded-full shadow-sm hover:scale-110 transition-all ${hovered ? 'opacity-100' : 'opacity-0'}`}
            onClick={(e) => {
              e.stopPropagation();
              setEdges((eds) => eds.filter((e) => e.id !== id));
            }}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { deletable: DeletableEdge };

export const PALETTE_ITEMS = [
  { type: 'agent',     label: 'Agent Node' },
  { type: 'parallel',  label: 'Parallel' },
  { type: 'condition', label: 'Condition' },
  { type: 'hitl',      label: 'Approval Gate' },
  { type: 'code',      label: 'Code' },
];

// ─── Shared node renderer ─────────────────────────────────────────────────────

function WorkflowNode({ data }: { data: Record<string, unknown> }) {
  const meta = NODE_TYPE_META[data.type as string] ?? NODE_TYPE_META.agent;
  const Icon = meta.icon;
  const runtimeStatus = data.runtimeStatus as string | undefined;
  const statusClass = runtimeStatus ? (NODE_STATUS_COLOR[runtimeStatus] ?? '') : '';
  const nodeType = data.type as string;
  const isConnectable = (data.isConnectable as boolean) ?? true;

  return (
    <>
      {nodeType !== 'input' && (
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={isConnectable} />
      )}
      <div
        className={`
          flex flex-col gap-1 rounded-lg border-2 px-3 py-2.5 min-w-[140px] max-w-[200px]
          bg-card text-card-foreground select-none cursor-default
          ${meta.color} ${statusClass}
        `}
      >
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="text-xs font-semibold truncate flex-1">{data.label as string}</span>
          {runtimeStatus && runtimeStatus !== 'waiting' && (
            <span className={`h-2 w-2 rounded-full shrink-0 ${
              runtimeStatus === 'completed'     ? 'bg-green-500' :
              runtimeStatus === 'failed'        ? 'bg-red-500' :
              runtimeStatus === 'running'       ? 'bg-blue-400 animate-pulse' :
              runtimeStatus === 'awaiting_hitl' ? 'bg-amber-400 animate-pulse' :
              'bg-muted'
            }`} />
          )}
        </div>
        <span className="text-[10px] text-muted-foreground capitalize">
          {meta.label}{runtimeStatus ? ` · ${runtimeStatus}` : ''}
        </span>
      </div>
      {nodeType !== 'output' && (
        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={isConnectable} />
      )}
    </>
  );
}

const NODE_TYPES = { workflowNode: WorkflowNode };

// ─── Conversion helpers (exported for use in pages) ───────────────────────────

import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/lib/db/schema';

export function defsToFlow(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
  layout: Record<string, { x: number; y: number }>,
  runtimeStatuses?: Record<string, string>,
  readOnly = false,
): { nodes: Node[]; edges: Edge[] } {
  const rfNodes: Node[] = nodes.map((n, i) => ({
    id: n.id,
    type: 'workflowNode',
    position: layout[n.id] ?? { x: 100 + i * 220, y: 200 },
    data: { ...n, runtimeStatus: runtimeStatuses?.[n.id], isConnectable: !readOnly },
  }));

  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label,
    animated: runtimeStatuses ? runtimeStatuses[e.sourceNodeId] === 'running' : true,
    type: readOnly ? undefined : 'deletable',
  }));

  return { nodes: rfNodes, edges: rfEdges };
}

export function flowToDefs(nodes: Node[], edges: Edge[]): {
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
  layout: Record<string, { x: number; y: number }>;
} {
  const nodeDefs: WorkflowNodeDef[] = nodes.map((n) => ({
    id: n.id,
    type: n.data.type as WorkflowNodeDef['type'],
    label: n.data.label as string,
    config: (n.data.config as WorkflowNodeDef['config']) ?? {},
  }));

  const edgeDefs: WorkflowEdgeDef[] = edges.map((e) => ({
    id: e.id,
    sourceNodeId: e.source,
    targetNodeId: e.target,
    label: e.label as string | undefined,
  }));

  const layout: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) layout[n.id] = n.position;

  return { nodes: nodeDefs, edges: edgeDefs, layout };
}

// Re-export xyflow helpers so pages import from one place
export { applyNodeChanges, applyEdgeChanges, addEdge };
export type { Node, Edge, NodeChange, EdgeChange, Connection, IsValidConnection };

// ─── WorkflowCanvas component ─────────────────────────────────────────────────

interface EditProps {
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (params: Connection) => void;
  isValidConnection?: IsValidConnection;
  onAddNode?: (type: string) => void;
}

interface WorkflowCanvasProps {
  nodes: Node[];
  edges: Edge[];
  onNodeClick?: (event: React.MouseEvent, node: Node) => void;
  onPaneClick?: () => void;
  edit?: EditProps;
}

function WorkflowCanvasInner({
  nodes,
  edges,
  onNodeClick,
  onPaneClick,
  edit,
}: WorkflowCanvasProps) {
  const readOnly = !edit;
  const { fitView } = useReactFlow();
  const fittedRef = React.useRef(false);

  // Fit once after the first non-empty nodes load — not on every update
  React.useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return;
    fittedRef.current = true;
    // Defer until after React Flow has measured node dimensions
    requestAnimationFrame(() => fitView({ padding: 0.15 }));
  }, [nodes, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={edit?.onNodesChange}
      onEdgesChange={edit?.onEdgesChange}
      onConnect={edit?.onConnect}
      isValidConnection={edit?.isValidConnection}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      nodeTypes={NODE_TYPES}
      edgeTypes={readOnly ? undefined : EDGE_TYPES}
      defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      elementsSelectable={true}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="opacity-30" />
      <Controls showInteractive={!readOnly} />
      <MiniMap
        nodeColor={(n) => (NODE_TYPE_META[n.data?.type as string] ? '#6366f1' : '#94a3b8')}
        className="!bg-card !border-border"
      />

      {edit?.onAddNode && (
        <Panel position="top-left" className="lg:hidden flex gap-1">
          {PALETTE_ITEMS.map((item) => {
            const meta = NODE_TYPE_META[item.type];
            const Icon = meta.icon;
            return (
              <button
                key={item.type}
                onClick={() => edit.onAddNode!(item.type)}
                title={item.label}
                className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium ${meta.color}`}
              >
                <Icon className="h-3 w-3" />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </Panel>
      )}
    </ReactFlow>
  );
}

// WorkflowCanvas renders the ReactFlow canvas. It must be a descendant of
// WorkflowProvider (exported below) — hoist the provider to the page level so
// it never remounts when data-loading state changes.
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return <WorkflowCanvasInner {...props} />;
}

export function WorkflowProvider({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}
