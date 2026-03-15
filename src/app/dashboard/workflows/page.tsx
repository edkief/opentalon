'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Plus, Play, Archive, RefreshCw, Workflow, Clock, CheckCircle2, XCircle, Pause } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Workflow as WorkflowRow } from '@/lib/db/schema';

type WorkflowWithRun = WorkflowRow & {
  lastRunStatus?: string | null;
  lastRunAt?: string | null;
};

function statusBadge(status: string) {
  switch (status) {
    case 'active':  return <Badge variant="default">{status}</Badge>;
    case 'draft':   return <Badge variant="secondary">{status}</Badge>;
    case 'archived': return <Badge variant="outline" className="opacity-60">{status}</Badge>;
    default:        return <Badge variant="outline">{status}</Badge>;
  }
}

function runStatusIcon(status?: string | null) {
  if (!status) return null;
  switch (status) {
    case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case 'failed':    return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case 'running':   return <RefreshCw className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
    case 'paused':    return <Pause className="h-3.5 w-3.5 text-amber-500" />;
    default:          return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowWithRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/workflow');
      const data = await res.json() as WorkflowRow[];
      setWorkflows(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
      });
      if (res.ok) {
        const row = await res.json() as WorkflowRow;
        setDialogOpen(false);
        setNewName('');
        setNewDesc('');
        // Navigate to editor
        window.location.href = `/dashboard/workflows/${row.id}`;
      }
    } finally {
      setCreating(false);
    }
  };

  const handleArchive = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/workflow/${id}`, { method: 'DELETE' });
    load();
  };

  const handleRun = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/workflow/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    load();
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Workflow className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">Workflows</h1>
            <p className="text-sm text-muted-foreground">Visual agent pipelines — sequential, parallel, conditional</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Workflow
          </Button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
          <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      ) : workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground border border-dashed rounded-lg">
          <Workflow className="h-8 w-8 opacity-40" />
          <p className="text-sm">No workflows yet. Create one to get started.</p>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Workflow
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {workflows.map((wf) => (
            <Link
              key={wf.id}
              href={`/dashboard/workflows/${wf.id}`}
              className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card hover:bg-accent/40 transition-colors group"
            >
              <Workflow className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{wf.name}</span>
                  {statusBadge(wf.status)}
                </div>
                {wf.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{wf.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  Updated {new Date(wf.updatedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {runStatusIcon(wf.lastRunStatus)}
              </div>
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {wf.status !== 'archived' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => handleRun(wf.id, e)}
                    title="Run workflow"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                )}
                {wf.status !== 'archived' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => handleArchive(wf.id, e)}
                    title="Archive workflow"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workflow</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-2">
            <div>
              <label className="text-sm font-medium mb-1 block">Name</label>
              <Input
                autoFocus
                placeholder="e.g. Code Review Pipeline"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Input
                placeholder="What does this workflow do?"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="flex justify-end gap-2 mt-1">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
                {creating ? <RefreshCw className="h-4 w-4 animate-spin mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
                Create & Edit
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
