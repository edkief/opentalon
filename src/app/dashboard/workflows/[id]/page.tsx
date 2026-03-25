'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Save, Play, ArrowLeft, Trash2, RefreshCw, History,
  ChevronDown, ChevronRight, AlertCircle, TriangleAlert, Pencil, Download,
} from 'lucide-react';
import { downloadWorkflow } from '@/lib/workflow/export';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import type { Workflow, WorkflowNodeDef, WorkflowEdgeDef, WorkflowRun } from '@/lib/db/schema';
import { wouldCreateCycle, type ValidationIssue } from '@/lib/workflow/topology';
import {
  WorkflowCanvas,
  WorkflowProvider,
  NODE_TYPE_META,
  PALETTE_ITEMS,
  defsToFlow,
  flowToDefs,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type IsValidConnection,
} from '@/components/workflow/WorkflowCanvas';

// ─── Config panel ─────────────────────────────────────────────────────────────

function ConfigPanel({
  node,
  onUpdate,
  onDelete,
  onUpdateEdge,
  edges,
  nodes,
  agents,
}: {
  node: Node;
  onUpdate: (id: string, changes: Partial<{ label: string; config: Record<string, unknown> }>) => void;
  onDelete: (id: string) => void;
  onUpdateEdge: (id: string, label: string) => void;
  edges: Edge[];
  nodes: Node[];
  agents: string[];
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
            <label className="text-xs text-muted-foreground mb-1 block">Agent <span className="opacity-60">(optional)</span></label>
            <select
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              value={(config.agentId as string) ?? ''}
              onChange={(e) => onUpdate(node.id, { config: { ...config, agentId: e.target.value || undefined } })}
            >
              <option value="">— use default agent —</option>
              {agents.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
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
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Timeout (seconds)</label>
            <Input
              className="h-7 text-xs"
              type="number"
              min={5}
              step={5}
              value={((config.timeoutMs as number) ?? 60000) / 1000}
              onChange={(e) => onUpdate(node.id, { config: { ...config, timeoutMs: Number(e.target.value) * 1000 } })}
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
          {(() => {
            const outEdges = edges.filter((e) => e.source === node.id);
            const trueLabel = (config.trueEdgeLabel as string) || 'true';
            const falseLabel = (config.falseEdgeLabel as string) || 'false';
            return (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Branch labels</label>
                {outEdges.length === 0 && (
                  <p className="text-[10px] text-muted-foreground">Connect two outgoing edges first.</p>
                )}
                {outEdges.map((edge) => {
                  const targetNode = nodes.find((n) => n.id === edge.target);
                  const targetLabel = (targetNode?.data?.label as string) ?? edge.target.slice(0, 8);
                  const currentLabel = (edge.label as string) ?? '';
                  return (
                    <div key={edge.id} className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] text-muted-foreground truncate flex-1" title={targetLabel}>→ {targetLabel}</span>
                      <select
                        className="rounded border border-input bg-background px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                        value={currentLabel}
                        onChange={(e) => onUpdateEdge(edge.id, e.target.value)}
                      >
                        <option value="">— unset —</option>
                        <option value={trueLabel}>{trueLabel} (true)</option>
                        <option value={falseLabel}>{falseLabel} (false)</option>
                      </select>
                    </div>
                  );
                })}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block">True label</label>
                    <Input
                      className="h-6 text-xs"
                      value={trueLabel}
                      onChange={(e) => onUpdate(node.id, { config: { ...config, trueEdgeLabel: e.target.value } })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block">False label</label>
                    <Input
                      className="h-6 text-xs"
                      value={falseLabel}
                      onChange={(e) => onUpdate(node.id, { config: { ...config, falseEdgeLabel: e.target.value } })}
                    />
                  </div>
                </div>
              </div>
            );
          })()}
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

// ─── Run history panel ────────────────────────────────────────────────────────

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

// ─── Editor page ──────────────────────────────────────────────────────────────

export default function WorkflowEditorPage() {
  const params = useParams<{ id: string }>();
  const workflowId = params.id;
  const router = useRouter();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Stable ref so isValidConnection never captures stale edges
  const edgesRef = useRef<Edge[]>(edges);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const [running, setRunning] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const isDirty = useRef(false);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((data: unknown) => {
        const list = (data as { agents?: { id: string }[] })?.agents;
        if (!Array.isArray(list)) return;
        setAgents(list.map((p) => p.id));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/workflow/${workflowId}`, { signal: ctrl.signal });
        if (!res.ok) { router.push('/dashboard/workflows'); return; }
        const wf = await res.json() as Workflow;
        if (ctrl.signal.aborted) return;
        setWorkflow(wf);
        const def = wf.definition as { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] };
        const layout = (wf.layout ?? {}) as Record<string, { x: number; y: number }>;
        const { nodes: rfNodes, edges: rfEdges } = defsToFlow(def.nodes, def.edges, layout);
        setNodes(rfNodes);
        setEdges(rfEdges);
        isDirty.current = false;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        throw err;
      }
    };
    load();
    return () => ctrl.abort();
  }, [workflowId, router]);

  // ── Canvas callbacks ───────────────────────────────────────────────────────

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const mutating = changes.some((c) => c.type !== 'select' && c.type !== 'dimensions');
      if (mutating) isDirty.current = true;
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      isDirty.current = true;
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [],
  );
  const onConnect = useCallback(
    (params: Connection) => { isDirty.current = true; setEdges((eds) => addEdge(params, eds)); },
    [],
  );
  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const src = connection.source;
      const tgt = connection.target;
      if (!src || !tgt || src === tgt) return false;
      const currentEdgeDefs: WorkflowEdgeDef[] = edgesRef.current.map((e) => ({
        id: e.id,
        sourceNodeId: e.source,
        targetNodeId: e.target,
      }));
      return !wouldCreateCycle(src, tgt, currentEdgeDefs);
    },
    [],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);
  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const updateNode = useCallback(
    (id: string, changes: Partial<{ label: string; config: Record<string, unknown> }>) => {
      isDirty.current = true;
      setNodes((nds: Node[]) => nds.map((n) => n.id === id ? { ...n, data: { ...n.data, ...changes } } : n));
      setSelectedNode((prev) => prev?.id === id ? { ...prev, data: { ...prev.data, ...changes } } : prev);
    },
    [],
  );

  const updateEdge = useCallback((id: string, label: string) => {
    isDirty.current = true;
    setEdges((eds) => eds.map((e) => e.id === id ? { ...e, label } : e));
  }, []);

  const deleteNode = useCallback((id: string) => {
    isDirty.current = true;
    setNodes((nds: Node[]) => nds.filter((n) => n.id !== id));
    setEdges((eds: Edge[]) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedNode(null);
  }, []);

  const addNode = useCallback((type: string) => {
    isDirty.current = true;
    const id = crypto.randomUUID();
    const meta = NODE_TYPE_META[type] ?? NODE_TYPE_META.agent;
    setNodes((nds: Node[]) => [...nds, {
      id,
      type: 'workflowNode',
      position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: { id, type, label: meta.label, config: {}, isConnectable: true },
    }]);
  }, []);

  // ── Save & Run ─────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setValidationIssues([]);
    try {
      const { nodes: nodeDefs, edges: edgeDefs, layout } = flowToDefs(nodes, edges);
      const res = await fetch(`/api/workflow/${workflowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: { nodes: nodeDefs, edges: edgeDefs }, layout, status: 'active' }),
      });
      if (!res.ok) {
        const body = await res.json() as { error: string; issues?: ValidationIssue[] };
        const issues = body.issues ?? [{ level: 'error', message: body.error }];
        setValidationIssues(issues);
        setShowProblems(true);
        setSaveStatus('error');
      } else {
        isDirty.current = false;
        setValidationIssues([]);
        setShowProblems(false);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      }
    } finally {
      setSaving(false);
    }
  }, [nodes, edges, workflowId]);

  const handleSaveRef = useRef(handleSave);
  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSaveRef.current(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
        isDirty.current = false;
        router.push(`/dashboard/workflows/${workflowId}/runs/${runId}`);
      }
    } finally {
      setRunning(false);
    }
  }, [workflowId, router]);

  // ── Unsaved-changes guard ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty.current) return;
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const navigateAway = useCallback((href: string) => {
    if (isDirty.current) {
      if (!window.confirm('You have unsaved changes. Leave without saving?')) return;
    }
    router.push(href);
  }, [router]);

  // ── Rename ─────────────────────────────────────────────────────────────────

  const startRename = useCallback(() => {
    if (!workflow) return;
    setNameValue(workflow.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  }, [workflow]);

  const commitRename = useCallback(async () => {
    const trimmed = nameValue.trim();
    if (!trimmed || !workflow || trimmed === workflow.name) {
      setEditingName(false);
      return;
    }
    await fetch(`/api/workflow/${workflowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    setWorkflow((prev) => prev ? { ...prev, name: trimmed } : prev);
    setEditingName(false);
  }, [nameValue, workflow, workflowId]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!workflow) {
    return (
      <WorkflowProvider>
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      </WorkflowProvider>
    );
  }

  return (
    <WorkflowProvider>
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background shrink-0">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => navigateAway('/dashboard/workflows')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0 flex items-center gap-1">
          {editingName ? (
            <Input
              ref={nameInputRef}
              className="h-7 text-sm font-semibold w-56"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditingName(false);
              }}
            />
          ) : (
            <button
              className="font-semibold text-sm truncate hover:underline underline-offset-2 cursor-text flex items-center gap-1.5 group/name"
              onClick={startRename}
              title="Click to rename"
            >
              {workflow.name}
              <Pencil className="h-3 w-3 opacity-0 group-hover/name:opacity-60 transition-opacity" />
            </button>
          )}
          {workflow.description && (
            <span className="text-xs text-muted-foreground ml-1 truncate">{workflow.description}</span>
          )}
        </div>
        <Button variant="outline" size="sm" className="h-7" onClick={() => setShowRuns((v) => !v)}>
          <History className="h-3.5 w-3.5 mr-1" /> Runs
        </Button>
        <Button variant="outline" size="sm" className="h-7" onClick={() => downloadWorkflow(workflow)}>
          <Download className="h-3.5 w-3.5 mr-1" /> Export
        </Button>
        <Button variant="outline" size="sm" className="h-7" onClick={handleSave} disabled={saving}>
          {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          <span className="ml-1">
            {saving ? 'Saving…' : saveStatus === 'saved' ? 'Saved ✓' : 'Save'}
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

        {/* Centre column: canvas + problems panel */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Canvas */}
          <div className="flex-1 relative">
            <WorkflowCanvas
              nodes={nodes}
              edges={edges}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              edit={{ onNodesChange, onEdgesChange, onConnect, isValidConnection, onAddNode: addNode }}
            />
          </div>

          {/* Status bar */}
          {(() => {
            const errorCount = validationIssues.filter((i) => i.level === 'error').length;
            const warnCount  = validationIssues.filter((i) => i.level === 'warning').length;
            return (
              <div className="flex items-center gap-3 px-3 h-6 border-t border-border bg-muted/40 text-[11px] shrink-0 select-none">
                {errorCount > 0 && (
                  <button
                    className="flex items-center gap-1 text-destructive hover:opacity-80 transition-opacity"
                    onClick={() => setShowProblems((v) => !v)}
                  >
                    <AlertCircle className="h-3 w-3" />
                    {errorCount} error{errorCount !== 1 ? 's' : ''}
                  </button>
                )}
                {warnCount > 0 && (
                  <button
                    className="flex items-center gap-1 text-amber-500 hover:opacity-80 transition-opacity"
                    onClick={() => setShowProblems((v) => !v)}
                  >
                    <TriangleAlert className="h-3 w-3" />
                    {warnCount} warning{warnCount !== 1 ? 's' : ''}
                  </button>
                )}
                {validationIssues.length === 0 && saveStatus === 'saved' && (
                  <span className="text-muted-foreground">No problems</span>
                )}
              </div>
            );
          })()}

          {/* Problems panel */}
          {showProblems && validationIssues.length > 0 && (
            <div className="border-t border-border bg-background shrink-0 max-h-48 overflow-y-auto">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Problems</span>
                <button
                  className="text-muted-foreground hover:text-foreground transition-colors text-xs"
                  onClick={() => setShowProblems(false)}
                >
                  ✕
                </button>
              </div>
              <ul className="py-1">
                {validationIssues.map((issue, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 px-3 py-1 text-xs hover:bg-accent/40 transition-colors ${
                      issue.nodeId ? 'cursor-pointer' : ''
                    }`}
                    onClick={() => {
                      if (!issue.nodeId) return;
                      const node = nodes.find((n) => n.id === issue.nodeId);
                      if (node) setSelectedNode(node);
                    }}
                  >
                    {issue.level === 'error'
                      ? <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-px" />
                      : <TriangleAlert className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-px" />}
                    <span className={issue.level === 'error' ? 'text-foreground' : 'text-amber-600 dark:text-amber-400'}>
                      {issue.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="w-64 flex flex-col border-l border-border bg-background shrink-0 overflow-y-auto">
          {selectedNode ? (
            <ConfigPanel node={selectedNode} onUpdate={updateNode} onDelete={deleteNode} onUpdateEdge={updateEdge} edges={edges} nodes={nodes} agents={agents} />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">Click a node to configure it.</div>
          )}
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
    </WorkflowProvider>
  );
}
