'use client';

import { useEffect, useState, useCallback } from 'react';
import { CalendarClock, Plus, Pencil, Trash2, RefreshCw, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScheduleView {
  scheduleName: string;
  taskId: string;
  chatId: string;
  description: string;
  cron: string;
  nextRunAt: string | null;
}

interface OneOffTaskView {
  taskId: string;
  chatId: string;
  description: string;
  runAt: string;
  state: 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';
}

interface FormState {
  chatId: string;
  description: string;
  cronExpression: string;
}

import cronstrue from 'cronstrue';

const EMPTY_FORM: FormState = { chatId: '', description: '', cronExpression: '' };

function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true });
  } catch {
    return '';
  }
}

function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const future = diffMs > 0;

  if (abs < 60_000) return future ? 'in seconds' : 'just now';
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

function validateCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 && !parts.some((p) => p === '');
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ScheduledTasksPage() {
  const [tasks, setTasks] = useState<ScheduleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [oneOffTasks, setOneOffTasks] = useState<OneOffTaskView[]>([]);
  const [oneOffLoading, setOneOffLoading] = useState(false);
  const [oneOffError, setOneOffError] = useState<string | null>(null);

  // Known chats for the dropdown
  const [chatOptions, setChatOptions] = useState<{ chatId: string; name: string }[]>([]);

  // Load known chats on mount
  useEffect(() => {
    fetch('/api/chats')
      .then((r) => r.json())
      .then((data: { chatId: string; name: string }[]) => setChatOptions(data))
      .catch(() => {});
  }, []);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduleView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<ScheduleView | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Data fetching ────────────────────────────────────────────────────────────

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/scheduled-tasks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOneOffTasks = useCallback(async () => {
    setOneOffLoading(true);
    setOneOffError(null);
    try {
      const res = await fetch('/api/scheduled-tasks/once');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOneOffTasks(Array.isArray(data) ? data : []);
    } catch (e) {
      setOneOffError(e instanceof Error ? e.message : 'Failed to load one-off tasks');
    } finally {
      setOneOffLoading(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    void loadTasks();
    void loadOneOffTasks();
  }, [loadTasks, loadOneOffTasks]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // ── Dialog helpers ───────────────────────────────────────────────────────────

  function openCreate() {
    setEditingTask(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(task: ScheduleView) {
    setEditingTask(task);
    setForm({
      chatId: task.chatId,
      description: task.description,
      cronExpression: task.cron,
    });
    setFormError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    setFormError(null);
    if (!form.chatId.trim()) { setFormError('Chat ID is required'); return; }
    if (!form.description.trim()) { setFormError('Description is required'); return; }
    if (!validateCron(form.cronExpression)) {
      setFormError('Cron expression must have exactly 5 fields (e.g. "0 9 * * 1-5")');
      return;
    }

    setSaving(true);
    try {
      let res: Response;
      if (editingTask) {
        res = await fetch(`/api/scheduled-tasks/${editingTask.taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: form.description.trim(),
            cronExpression: form.cronExpression.trim(),
          }),
        });
      } else {
        res = await fetch('/api/scheduled-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: form.chatId.trim(),
            description: form.description.trim(),
            cronExpression: form.cronExpression.trim(),
          }),
        });
      }
      const body = await res.json();
      if (!res.ok) { setFormError(body.error ?? `HTTP ${res.status}`); return; }
      setDialogOpen(false);
      await loadTasks();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`/api/scheduled-tasks/${deleteTarget.scheduleName}`, { method: 'DELETE' });
      setDeleteTarget(null);
      await loadTasks();
    } catch {
      await loadTasks();
    } finally {
      setDeleting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Scheduled Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Recurring tasks the agent runs automatically on a cron schedule.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={refreshAll}
            disabled={loading || oneOffLoading}
            aria-label="Refresh"
          >
            <RefreshCw
              className={[
                'h-4 w-4',
                loading || oneOffLoading ? 'animate-spin' : '',
              ].join(' ')}
            />
          </Button>
          <Button size="sm" onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            Create Task
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm gap-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Loading tasks…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && tasks.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center py-16">
          <CalendarClock className="h-12 w-12 text-muted-foreground/40" />
          <div>
            <p className="text-base font-medium text-foreground">No scheduled tasks yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create a task to have the agent run automatically on a schedule.
            </p>
          </div>
          <Button size="sm" onClick={openCreate} className="gap-2 mt-2">
            <Plus className="h-4 w-4" />
            Create Task
          </Button>
        </div>
      )}

      {/* Table */}
      {!loading && !error && tasks.length > 0 && (
        <div className="flex-1 overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-48">Task</TableHead>
                <TableHead className="w-36 hidden md:table-cell">Chat</TableHead>
                <TableHead className="w-44 hidden lg:table-cell">Schedule</TableHead>
                <TableHead className="w-28 hidden lg:table-cell">Next Run</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.taskId}>
                  <TableCell className="max-w-xs align-top">
                    <span className="text-sm font-medium whitespace-normal break-words">
                      {task.description}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {(() => {
                      const chatName = chatOptions.find((c) => c.chatId === task.chatId)?.name;
                      const displayName = chatName && chatName !== task.chatId ? `${chatName} (${task.chatId})` : task.chatId;
                      return (
                        <code className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                          {displayName}
                        </code>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex flex-col gap-0.5">
                      <code className="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded w-fit">
                        {task.cron}
                      </code>
                      {describeCron(task.cron) && (
                        <span className="text-xs text-muted-foreground">{describeCron(task.cron)}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3 shrink-0" />
                      {relativeTime(task.nextRunAt)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(task)}
                        aria-label="Edit task"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleteTarget(task)}
                        aria-label="Delete task"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* One-off tasks */}
      <div className="shrink-0 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" />
              One-off tasks
            </h2>
            <p className="text-xs text-muted-foreground">
              Single-run reminders the agent will execute once at the scheduled time.
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={loadOneOffTasks}
            disabled={oneOffLoading}
            aria-label="Refresh one-off tasks"
          >
            <RefreshCw
              className={[
                'h-4 w-4',
                oneOffLoading ? 'animate-spin' : '',
              ].join(' ')}
            />
          </Button>
        </div>

        {oneOffError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {oneOffError}
          </div>
        )}

        {oneOffLoading && !oneOffError && (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Loading one-off tasks…
          </div>
        )}

        {!oneOffLoading && !oneOffError && oneOffTasks.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No one-off tasks scheduled.
          </p>
        )}

        {!oneOffLoading && !oneOffError && oneOffTasks.length > 0 && (
          <div className="max-h-60 overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-48">Task</TableHead>
                  <TableHead className="w-36 hidden md:table-cell">Chat</TableHead>
                  <TableHead className="w-40 hidden lg:table-cell">Run at</TableHead>
                  <TableHead className="w-28 hidden lg:table-cell">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {oneOffTasks.map((task) => (
                  <TableRow key={task.taskId}>
                    <TableCell className="max-w-xs align-top">
                      <span className="text-sm font-medium whitespace-normal break-words">
                        {task.description}
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {(() => {
                        const chatName = chatOptions.find((c) => c.chatId === task.chatId)?.name;
                        const displayName = chatName && chatName !== task.chatId ? `${chatName} (${task.chatId})` : task.chatId;
                        return (
                          <code className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                            {displayName}
                          </code>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="text-xs text-muted-foreground flex flex-col">
                        <span>{new Date(task.runAt).toLocaleString()}</span>
                        <span>{relativeTime(task.runAt)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="text-xs text-muted-foreground capitalize">
                        {task.state}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingTask ? 'Edit Scheduled Task' : 'Create Scheduled Task'}</DialogTitle>
            <DialogDescription>
              The agent will be invoked with your description at each scheduled time.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            {/* Chat ID — only shown for new tasks */}
            {!editingTask && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="chatId">
                  Chat
                </label>
                {chatOptions.length > 0 ? (
                  <select
                    id="chatId"
                    value={form.chatId}
                    onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))}
                    className="h-9 rounded-md border border-input bg-background px-3 pr-8 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 cursor-pointer font-mono"
                  >
                    <option value="">Select a chat…</option>
                    {chatOptions.map(({ chatId, name }) => (
                      <option key={chatId} value={chatId}>
                        {name !== chatId ? `${name} (${chatId})` : chatId}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="chatId"
                    placeholder="e.g. -1001234567890"
                    value={form.chatId}
                    onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))}
                    className="font-mono text-sm"
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  The chat where the agent will send its response.
                </p>
              </div>
            )}

            {/* Description */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="description">
                Schedule prompt
              </label>
              <Textarea
                id="description"
                placeholder="e.g. Fetch the latest Bitcoin price and send a brief summary"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
                className="text-sm resize-none"
              />
            </div>

            {/* Cron expression */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="cronExpr">
                Cron expression
              </label>
              <Input
                id="cronExpr"
                placeholder="0 9 * * 1-5"
                value={form.cronExpression}
                onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
                className="font-mono text-sm"
              />
              <div className="text-xs text-muted-foreground space-y-0.5">
                {form.cronExpression && describeCron(form.cronExpression) ? (
                  <p className="text-foreground/70 font-medium">
                    {describeCron(form.cronExpression)}
                  </p>
                ) : (
                  <p>5 fields: minute · hour · day · month · weekday</p>
                )}
                <p className="pt-0.5">
                  Examples:{' '}
                  <code className="bg-muted px-1 rounded">0 9 * * 1-5</code> (9am weekdays) ·{' '}
                  <code className="bg-muted px-1 rounded">0 8 * * *</code> (8am daily) ·{' '}
                  <code className="bg-muted px-1 rounded">*/30 * * * *</code> (every 30 min)
                </p>
              </div>
            </div>

            {/* Form error */}
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingTask ? 'Save changes' : 'Create task'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete scheduled task?</DialogTitle>
            <DialogDescription>
              This will permanently remove the task and stop any future runs. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-foreground/80">
              {deleteTarget.description}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete task'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
