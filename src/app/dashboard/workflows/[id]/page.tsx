'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type IsValidConnection,
  BackgroundVariant,
  Panel,
  addEdge,
} from '@xyflow/react';
import {
  Save, Play, ArrowLeft, Plus, Trash2, RefreshCw, History,
  Bot, GitMerge, GitBranch, ShieldCheck, ArrowRightFromLine, ArrowRightToLine,
  ChevronDown, ChevronRight, AlertCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import type { Workflow, WorkflowNodeDef, WorkflowEdgeDef, WorkflowRun } from '@/lib/db/schema';
import { wouldCreateCycle } from '@/lib/workflow/topology';

// ─── Node appearance helpers ──────────────────────────────────────────────────

const NODE_TYPE_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  input:     { label: 'Input',     icon: ArrowRightFromLine, color: 'bg-emerald-500/15 border-emerald-500/50' },
  output:    { label: 'Output',    icon: ArrowRightToLine,   color: 'bg-violet-500/15 border-violet-500/50' },
  agent:     { label: 'Agent',     icon: Bot,                color: 'bg-sky-500/15 border-sky-500/50' },
  parallel:  { label: 'Parallel',  icon: GitMerge,           color: 'bg-orange-500/15 border-orange-500/50' },
  condition: { label: 'Condition', icon: GitBranch,          color: 'bg-yellow-500/15 border-yellow-500/50' },
  hitl:      { label: 'Approval',  icon: ShieldCheck,        color: 'bg-rose-500/15 border-rose-500/50' },
};

const NODE_STATUS_COLOR: Record<string, string> = {
  waiting:      'border-border',
  running:      'border-blue-500 shadow-blue-500/20 shadow-md',
  completed:    'border-green-500',
  failed:       'border-red-500',
  skipped:      'border-border opacity-50',
  awaiting_hitl:'border-amber-400 shadow-amber-400/20 shadow-md',
};

// ─── Custom node renderer ─────────────────────────────────────────────────────

const HANDLE_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#6b7280',
  border: '2px solid white',
};

function WorkflowNode({ data }: { data: Record<string, unknown> }) {
  const meta = NODE_TYPE_META[data.type as string] ?? NODE_TYPE_META.agent;
  const Icon = meta.icon;
  const runtimeStatus = data.runtimeStatus as string | undefined;
  const statusClass = runtimeStatus ? NODE_STATUS_COLOR[runtimeStatus] ?? '' : '';
  const nodeType = data.type as string;

  return (
    <>
      {nodeType !== 'input' && (
        <Handle id="target" type="target" position={Position.Left} style={HANDLE_STYLE} />
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
        <span className="text-[10px] text-muted-foreground capitalize">{meta.label}</span>
      </div>
      {nodeType !== 'output' && (
        <Handle id="source" type="source" position={Position.Right} style={HANDLE_STYLE} />
      )}
    </>
  );
}

const nodeTypes = { workflowNode: WorkflowNode };

// ─── Convert between DB format and React Flow format ─────────────────────────

function defsToFlow(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
  layout: Record<string, { x: number; y: number }>,
  runtimeStatuses?: Record<string, string>,
): { nodes: Node[]; edges: Edge[] } {
  const rfNodes: Node[] = nodes.map((n, i) => ({
    id: n.id,
    type: 'workflowNode',
    position: layout[n.id] ?? { x: 100 + i * 220, y: 200 },
    data: { ...n, runtimeStatus: runtimeStatuses?.[n.id] },
  }));

  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    sourceHandle: 'source',
    targetHandle: 'target',
    label: e.label,
    animated: true,
    style: { stroke: 'hsl(var(--muted-foreground))' },
  }));

  return { nodes: rfNodes, edges: rfEdges };
}

function flowToDefs(nodes: Node[], edges: Edge[]): {
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

// ─── Node palette item types for dragging ────────────────────────────────────

const PALETTE_ITEMS = [
  { type: 'agent',     label: 'Agent Node' },
  { type: 'parallel',  label: 'Parallel' },
  { type: 'condition', label: 'Condition' },
  { type: 'hitl',      label: 'Approval Gate' },
];

// ─── Config panel ─────────────────────────────────────────────────────────────

function ConfigPanel({
  node,
  onUpdate,
  onDelete,
}: {
  node: Node;
  onUpdate: (id: string, changes: Partial<{ label: string; config: Record<string, unknown> }>) => void;
  onDelete: (id: string) => void;
}) {
  const meta = NODE_TYPE_META[node.data.type as string] ?? NODE_TYPE_META.agent;
  const config = (node.data.config as Record<string, unknown>) ?? {};
  const isFixed = node.data.type === 'input' || node.data.type === 'output';

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-xs uppercase tracking-wide text-muted-foreground">{meta.label} Config</span>
        {!isFixed && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-destructive hover:text-destructive"
            onClick={() => onDelete(node.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Label</label>
        <Input
          className="h-7 text-xs"
          value={node.data.label as string}
          onChange={(e) => onUpdate(node.id, { label: e.target.value })}
        />
      </div>

      {node.data.type === 'agent' && (
        <>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Task Template</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs min-h-[80px] resize-y focus:outline-none focus:ring-1 focus:ring-ring"
              value={(config.taskTemplate as string) ?? ''}
              placeholder="Describe the task. Use {{output}} to reference previous node output."
              onChange={(e) => onUpdate(node.id, { config: { ...config, taskTemplate: e.target.value } })}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Persona ID <span className="opacity-60">(optional)</span></label>
            <Input
              className="h-7 text-xs"
              value={(config.personaId as string) ?? ''}
              placeholder="default"
              onChange={(e) => onUpdate(node.id, { config: { ...config, personaId: e.target.value || undefined } })}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Max Steps</label>
            <Input
              className="h-7 text-xs"
              type="number"
              min={1}
              max={50}
              value={(config.maxSteps as number) ?? 15}
              onChange={(e) => onUpdate(node.id, { config: { ...config, maxSteps: Number(e.target.value) } })}
            />
          </div>
        </>
      )}

      {node.data.type === 'condition' && (
        <>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Expression <span className="opacity-60">(JS, receives `input`)</span></label>
            <Input
              className="h-7 text-xs font-mono"
              value={(config.expression as string) ?? ''}
              placeholder="input.output?.includes('error')"
              onChange={(e) => onUpdate(node.id, { config: { ...config, expression: e.target.value } })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">True edge label</label>
              <Input
                className="h-7 text-xs"
                value={(config.trueEdgeLabel as string) ?? 'true'}
                onChange={(e) => onUpdate(node.id, { config: { ...config, trueEdgeLabel: e.target.value } })}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">False edge label</label>
              <Input
                className="h-7 text-xs"
                value={(config.falseEdgeLabel as string) ?? 'false'}
                onChange={(e) => onUpdate(node.id, { config: { ...config, falseEdgeLabel: e.target.value } })}
              />
            </div>
          </div>
        </>
      )}

      {node.data.type === 'hitl' && (
        <>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Approval Prompt</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs min-h-[60px] resize-y focus:outline-none focus:ring-1 focus:ring-ring"
              value={(config.prompt as string) ?? ''}
              placeholder="Please review and approve to continue the workflow."
              onChange={(e) => onUpdate(node.id, { config: { ...config, prompt: e.target.value } })}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Timeout (ms)</label>
            <Input
              className="h-7 text-xs"
              type="number"
              value={(config.ttlMs as number) ?? 300000}
              onChange={(e) => onUpdate(node.id, { config: { ...config, ttlMs: Number(e.target.value) } })}
            />
          </div>
        </>
      )}

      {node.data.type === 'parallel' && (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Join Strategy</label>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            value={(config.joinStrategy as string) ?? 'all'}
            onChange={(e) => onUpdate(node.id, { config: { ...config, joinStrategy: e.target.value } })}
          >
            <option value="all">All — wait for every branch</option>
            <option value="first">First — take the fastest branch</option>
          </select>
          <p className="text-[10px] text-muted-foreground mt-1">Connect child agent nodes directly to this node's output handle.</p>
        </div>
      )}
    </div>
  );
}

// ─── Run history panel ─────────────────────────────────────────────────────────

function RunHistoryPanel({ workflowId }: { workflowId: string }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/workflow/${workflowId}/run`);
        const data = await res.json() as WorkflowRun[];
        setRuns(data);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [workflowId]);

  const statusColor = (s: string) => {
    if (s === 'completed') return 'text-green-500';
    if (s === 'failed') return 'text-destructive';
    if (s === 'running') return 'text-blue-500';
    if (s === 'paused') return 'text-amber-500';
    return 'text-muted-foreground';
  };

  if (loading) return <div className="p-3 text-xs text-muted-foreground">Loading…</div>;
  if (runs.length === 0) return <div className="p-3 text-xs text-muted-foreground">No runs yet.</div>;

  return (
    <div className="flex flex-col divide-y divide-border text-xs">
      {runs.map((run) => (
        <Link
          key={run.id}
          href={`/dashboard/workflows/${workflowId}/runs/${run.id}`}
          className="flex items-center justify-between px-3 py-2 hover:bg-accent/40 transition-colors"
        >
          <span className="font-mono opacity-60 shrink-0 mr-2">{run.id.slice(0, 8)}</span>
          <span className={`font-medium ${statusColor(run.status)}`}>{run.status}</span>
          <span className="text-muted-foreground ml-auto pl-2">
            {new Date(run.createdAt).toLocaleString()}
          </span>
        </Link>
      ))}
    </div>
  );
}

// ─── Inner editor (must be a child of ReactFlowProvider) ─────────────────────

function WorkflowEditorInner({ workflowId }: { workflowId: string }) {
  const router = useRouter();

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [cycleError, setCycleError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // Load workflow
  useEffect(() => {
    const load = async () => {
      const res = await fetch(`/api/workflow/${workflowId}`);
      if (!res.ok) { router.push('/dashboard/workflows'); return; }
      const wf = await res.json() as Workflow;
      setWorkflow(wf);
      const def = wf.definition as { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] };
      const layout = (wf.layout ?? {}) as Record<string, { x: number; y: number }>;
      const { nodes: rfNodes, edges: rfEdges } = defsToFlow(def.nodes, def.edges, layout);
      setNodes(rfNodes);
      setEdges(rfEdges);
    };
    load();
  }, [workflowId, router]);

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (edgeOrConnection) => {
      const c = edgeOrConnection as { source: string; target: string };
      if (!c.source || !c.target) return false;
      if (c.source === c.target) return false;
      const currentEdgeDefs: WorkflowEdgeDef[] = edges.map((e) => ({
        id: e.id,
        sourceNodeId: e.source,
        targetNodeId: e.target,
      }));
      return !wouldCreateCycle(c.source, c.target, currentEdgeDefs);
    },
    [edges],
  );

  const onConnect: OnConnect = useCallback(
    (connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: crypto.randomUUID(),
            animated: true,
            style: { stroke: 'hsl(var(--muted-foreground))' },
          },
          eds,
        ),
      ),
    [],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const updateNode = useCallback(
    (id: string, changes: Partial<{ label: string; config: Record<string, unknown> }>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, ...changes } }
            : n,
        ),
      );
      setSelectedNode((prev) =>
        prev?.id === id ? { ...prev, data: { ...prev.data, ...changes } } : prev,
      );
    },
    [],
  );

  const deleteNode = useCallback((id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedNode(null);
  }, []);

  const addNode = useCallback((type: string) => {
    const id = crypto.randomUUID();
    const meta = NODE_TYPE_META[type] ?? NODE_TYPE_META.agent;
    const newNode: Node = {
      id,
      type: 'workflowNode',
      position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: { id, type, label: meta.label, config: {} },
    };
    setNodes((nds) => [...nds, newNode]);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setCycleError(null);
    try {
      const { nodes: nodeDefs, edges: edgeDefs, layout } = flowToDefs(nodes, edges);
      const res = await fetch(`/api/workflow/${workflowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: { nodes: nodeDefs, edges: edgeDefs }, layout, status: 'active' }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        setCycleError(err.error);
        setSaveStatus('error');
      } else {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      }
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, workflowId]);

  const handleRun = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/workflow/${workflowId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const { runId } = await res.json() as { runId: string };
        router.push(`/dashboard/workflows/${workflowId}/runs/${runId}`);
      }
    } finally {
      setRunning(false);
    }
  }, [workflowId, router]);

  if (!workflow) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background shrink-0">
        <Link href="/dashboard/workflows">
          <Button variant="ghost" size="sm" className="h-7 px-2">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-sm truncate">{workflow.name}</span>
          {workflow.description && (
            <span className="text-xs text-muted-foreground ml-2">{workflow.description}</span>
          )}
        </div>

        {cycleError && (
          <div className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            {cycleError}
          </div>
        )}

        <Button variant="outline" size="sm" className="h-7" onClick={() => setShowRuns((v) => !v)}>
          <History className="h-3.5 w-3.5 mr-1" /> Runs
        </Button>

        <Button variant="outline" size="sm" className="h-7" onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          <span className="ml-1">
            {saving ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : saveStatus === 'error' ? 'Error' : 'Save'}
          </span>
        </Button>

        <Button size="sm" className="h-7" onClick={handleRun} disabled={running}>
          {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" /> : <Play className="h-3.5 w-3.5 mr-1" />}
          Run
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left palette */}
        <div className="w-40 flex-col border-r border-border bg-background p-3 gap-2 shrink-0 hidden lg:flex">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Add Node</p>
          {PALETTE_ITEMS.map((item) => {
            const meta = NODE_TYPE_META[item.type];
            const Icon = meta.icon;
            return (
              <button
                key={item.type}
                onClick={() => addNode(item.type)}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors hover:bg-accent ${meta.color}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Canvas */}
        <div className="flex-1 relative" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="opacity-30" />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const meta = NODE_TYPE_META[n.data?.type as string];
                return meta ? '#6366f1' : '#94a3b8';
              }}
              className="!bg-card !border-border"
            />
            {/* Mobile palette panel */}
            <Panel position="top-left" className="lg:hidden flex gap-1">
              {PALETTE_ITEMS.map((item) => {
                const meta = NODE_TYPE_META[item.type];
                const Icon = meta.icon;
                return (
                  <button
                    key={item.type}
                    onClick={() => addNode(item.type)}
                    title={item.label}
                    className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium ${meta.color}`}
                  >
                    <Icon className="h-3 w-3" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </button>
                );
              })}
            </Panel>
          </ReactFlow>
        </div>

        {/* Right panels */}
        <div className="w-64 flex flex-col border-l border-border bg-background shrink-0 overflow-y-auto">
          {/* Config panel */}
          {selectedNode ? (
            <ConfigPanel node={selectedNode} onUpdate={updateNode} onDelete={deleteNode} />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">
              Click a node to configure it.
            </div>
          )}

          {/* Run history panel */}
          <div className="border-t border-border">
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowRuns((v) => !v)}
            >
              {showRuns ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Run History
            </button>
            {showRuns && <RunHistoryPanel workflowId={workflowId} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main page wrapper (provides ReactFlow context) ──────────────────────────

export default function WorkflowEditorPage() {
  const params = useParams<{ id: string }>();
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner workflowId={params.id} />
    </ReactFlowProvider>
  );
}
