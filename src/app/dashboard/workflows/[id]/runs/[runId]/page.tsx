'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import React from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, CheckCircle2, XCircle, Clock, Pause,
  ChevronDown, ChevronRight, ShieldCheck, StopCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import type { Workflow, WorkflowRun, WorkflowRunNode, WorkflowNodeDef, WorkflowEdgeDef } from '@/lib/db/schema';
import type { WorkflowEvent } from '@/lib/agent/log-bus';
import { WorkflowCanvas, WorkflowProvider, defsToFlow, type Node, type Edge } from '@/components/workflow/WorkflowCanvas';

// ─── Run status badge ─────────────────────────────────────────────────────────

function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, React.ReactElement> = {
    completed: <Badge className="bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />completed</Badge>,
    failed:    <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />failed</Badge>,
    running:   <Badge className="bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30"><RefreshCw className="h-3 w-3 mr-1 animate-spin" />running</Badge>,
    paused:    <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30"><Pause className="h-3 w-3 mr-1" />paused — awaiting approval</Badge>,
    pending:   <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" />pending</Badge>,
  };
  return map[status] ?? <Badge variant="outline">{status}</Badge>;
}

// ─── Node detail panel ────────────────────────────────────────────────────────

function NodeDetail({
  runNode,
  onApprove,
  onDeny,
}: {
  runNode: WorkflowRunNode;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const [outputOpen, setOutputOpen] = useState(true);
  const [inputOpen, setInputOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold capitalize">{runNode.nodeType}</span>
        <Badge variant="outline" className="text-[10px]">{runNode.status}</Badge>
      </div>

      {runNode.startedAt && (
        <div className="text-muted-foreground">
          Started: {new Date(runNode.startedAt).toLocaleTimeString()}
          {runNode.completedAt && (
            <> · {Math.round((new Date(runNode.completedAt).getTime() - new Date(runNode.startedAt).getTime()) / 1000)}s</>
          )}
        </div>
      )}

      {runNode.errorMessage && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-destructive text-[11px]">
          {runNode.errorMessage}
        </div>
      )}

      {runNode.status === 'awaiting_hitl' && (
        <div className="flex gap-2 mt-1">
          <Button size="sm" className="h-7 flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={onApprove}>
            <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Approve
          </Button>
          <Button size="sm" variant="destructive" className="h-7 flex-1" onClick={onDeny}>
            <XCircle className="h-3.5 w-3.5 mr-1" /> Deny
          </Button>
        </div>
      )}

      {runNode.inputData && Object.keys(runNode.inputData).length > 0 && (
        <div>
          <button className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setInputOpen((v) => !v)}>
            {inputOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Input
          </button>
          {inputOpen && (
            <pre className="mt-1 rounded bg-muted p-2 text-[10px] overflow-auto max-h-40 whitespace-pre-wrap">
              {JSON.stringify(runNode.inputData, null, 2)}
            </pre>
          )}
        </div>
      )}

      {runNode.outputData && Object.keys(runNode.outputData).length > 0 && (
        <div>
          <button className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setOutputOpen((v) => !v)}>
            {outputOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Output
          </button>
          {outputOpen && (
            <pre className="mt-1 rounded bg-muted p-2 text-[10px] overflow-auto max-h-60 whitespace-pre-wrap">
              {typeof (runNode.outputData as Record<string, unknown>).output === 'string'
                ? (runNode.outputData as Record<string, unknown>).output as string
                : JSON.stringify(runNode.outputData, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Run view page ────────────────────────────────────────────────────────────

export default function RunViewPage() {
  const params = useParams<{ id: string; runId: string }>();
  const { id: workflowId, runId } = params;

  const [showWorkflow, setShowWorkflow] = useState<boolean>(false)
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [runNodes, setRunNodes] = useState<WorkflowRunNode[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedRunNode, setSelectedRunNode] = useState<WorkflowRunNode | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const buildFlow = useCallback((wf: Workflow, rnodes: WorkflowRunNode[]) => {
    setShowWorkflow(false)
    const def = wf.definition as { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] };
    const layout = (wf.layout ?? {}) as Record<string, { x: number; y: number }>;
    const statusMap: Record<string, string> = {};
    for (const rn of rnodes) statusMap[rn.nodeId] = rn.status;
    const { nodes: rfNodes, edges: rfEdges } = defsToFlow(def.nodes, def.edges, layout, statusMap, true);
    setNodes(rfNodes);
    setEdges(rfEdges);
    queueMicrotask(() => setShowWorkflow(true))
  }, []);

  const loadData = useCallback(async () => {
    const [wfRes, runRes] = await Promise.all([
      fetch(`/api/workflow/${workflowId}`),
      fetch(`/api/workflow/run/${runId}`),
    ]);
    if (!wfRes.ok || !runRes.ok) return;
    const wf = await wfRes.json() as Workflow;
    const { run: runData, nodes: rnodes } = await runRes.json() as { run: WorkflowRun; nodes: WorkflowRunNode[] };
    setWorkflow(wf);
    setRun(runData);
    setRunNodes(rnodes);
    buildFlow(wf, rnodes);
  }, [workflowId, runId, buildFlow]);

  useEffect(() => { loadData(); }, [loadData]);

  // SSE live updates
  useEffect(() => {
    const es = new EventSource('/api/workflow/stream');
    esRef.current = es;
    es.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data as string) as WorkflowEvent;
        if (event.runId === runId) loadData();
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [runId, loadData]);

  const handleCancel = useCallback(async () => {
    await fetch(`/api/workflow/run/${runId}/cancel`, { method: 'POST' });
    loadData();
  }, [runId, loadData]);

  const handleApprove = useCallback(async (rn: WorkflowRunNode) => {
    if (!rn.hitlId) return;
    await fetch(`/api/workflow/hitl/${rn.hitlId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    loadData();
  }, [loadData]);

  const handleDeny = useCallback(async (rn: WorkflowRunNode) => {
    if (!rn.hitlId) return;
    await fetch(`/api/workflow/hitl/${rn.hitlId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
    loadData();
  }, [loadData]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedRunNode(runNodes.find((r) => r.nodeId === node.id) ?? null);
  }, [runNodes]);

  return (
    <div className="flex flex-col h-full">
      {(!workflow || !run) && (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm absolute inset-0 z-10 bg-background">
          <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      )}
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-background shrink-0">
        <Link href={`/dashboard/workflows/${workflowId}`}>
          <Button variant="ghost" size="sm" className="h-7 px-2">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-sm">{workflow?.name}</span>
          <span className="text-xs text-muted-foreground ml-2 font-mono">{runId.slice(0, 8)}</span>
        </div>
        {run && <RunStatusBadge status={run.status} />}
        {run && ['running', 'paused'].includes(run.status) && (
          <Button variant="destructive" size="sm" className="h-7" onClick={handleCancel}>
            <StopCircle className="h-3.5 w-3.5 mr-1" /> Cancel
          </Button>
        )}
        <Button variant="outline" size="sm" className="h-7" onClick={loadData}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas — read-only (no edit prop) */}
        <div className="flex-1 relative">
          {showWorkflow && 
            <WorkflowProvider>
              <WorkflowCanvas
                nodes={nodes}
                edges={edges}
                onNodeClick={onNodeClick}
              />
            </WorkflowProvider>
          }
        </div>

        {/* Right panel */}
        <div className="w-64 flex flex-col border-l border-border bg-background shrink-0 overflow-y-auto">
          {selectedRunNode ? (
            <NodeDetail
              runNode={selectedRunNode}
              onApprove={() => handleApprove(selectedRunNode)}
              onDeny={() => handleDeny(selectedRunNode)}
            />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">
              Click a node to inspect its input/output.
            </div>
          )}

          {/* Node list */}
          <div className="border-t border-border mt-auto">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-3 pt-3 pb-1">All Nodes</p>
            {runNodes.map((rn) => (
              <button
                key={rn.id}
                onClick={() => setSelectedRunNode(rn)}
                className={`flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-accent/40 transition-colors text-left ${selectedRunNode?.id === rn.id ? 'bg-accent' : ''}`}
              >
                <span className={`h-2 w-2 rounded-full shrink-0 ${
                  rn.status === 'completed'     ? 'bg-green-500' :
                  rn.status === 'failed'        ? 'bg-red-500' :
                  rn.status === 'running'       ? 'bg-blue-400 animate-pulse' :
                  rn.status === 'awaiting_hitl' ? 'bg-amber-400 animate-pulse' :
                  'bg-muted'
                }`} />
                <span className="flex-1 truncate">{rn.nodeId.slice(0, 8)} ({rn.nodeType})</span>
                <span className="text-muted-foreground capitalize">{rn.status}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
