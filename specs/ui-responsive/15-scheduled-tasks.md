# 15 — Scheduled Tasks

File: `src/app/dashboard/scheduled-tasks/page.tsx` · Severity: **High**

Recurring cron tasks (table) + one-off tasks (table), a create/edit dialog, and a
delete-confirm dialog.

## Current state

- Root: `flex flex-col h-full gap-6`.
- Header: `flex items-center justify-between` — title + subtitle / Refresh +
  **Create Task**. No wrap.
- Run-now notification + error banners.
- **Recurring table** (`@/components/ui/table`): columns Enabled (Switch), Task,
  Agent (`hidden md:table-cell`), Chat (`hidden md:table-cell`), Schedule
  (`hidden lg:table-cell`), Next Run (`hidden lg:table-cell`), Actions
  (Run/Edit/Delete icon buttons).
- **One-off table**: Task, Agent/Chat (`hidden md:`), Run at/State (`hidden lg:`),
  Actions (Cancel icon button → confirm dialog → `DELETE /api/scheduled-tasks/once?taskId=`).
  Cancel is shown only for rows with `cancellable: true` — queued (`created`/`retry`),
  user-scheduled tasks. Running tasks and background specialist jobs have no action.
- Create/Edit `Dialog` (`sm:max-w-lg`): chat select, prompt textarea, cron input
  (with `cronstrue` description), persona select.

## Responsive issues

1. **P3 — columns hidden, not reflowed.** On phones only Enabled + Task + Actions
   remain; **Schedule (cron), Next Run, Agent, and Chat are entirely hidden**. A
   phone user cannot see *when* a task runs or *which* agent/chat it targets — key
   information is dropped, not relocated.
2. **P1 — header** title + subtitle + 2 actions, no wrap; "Create Task" has a label
   + icon. Tight at 360px.
3. The create/edit dialog is long (4 fields + cron help text); verify it scrolls on
   short phones.

## Build tasks

1. **Responsive rows (P3) — recurring tasks:**
   - `md+`: keep the table (with its current `hidden md/lg:table-cell` columns).
   - `< md`: render a `md:hidden` card per task:
     - Header line: Enabled `Switch` + Task description (wraps).
     - Body lines (labelled, small): `Schedule:` cron + human description
       (`describeCron`), `Next run:` `relativeTime`, `Agent:` badge, `Chat:` name.
     - Footer: Run / Edit / Delete buttons (≥ 36px, with text labels or large icons).
   - Reuse `describeCron` / `relativeTime` for both views.
2. **Responsive rows (P3) — one-off tasks:** same card treatment below `md`
   (Task + Run at + relative + State), with a Cancel button in the card footer when
   the task is `cancellable`.
3. **Header (P1):** `flex-wrap gap-2`; on phones make Refresh icon-only and keep
   Create Task (icon + `hidden sm:inline` label).
4. **Dialog:** add `max-h-[90vh] overflow-y-auto` to `DialogContent` so the form
   scrolls with the keyboard open.

## Acceptance criteria

- At 360px: each scheduled task shows its schedule (cron + plain-English), next run,
  agent, and chat — nothing important hidden — plus Run/Edit/Delete.
- Enable/disable toggle, create, edit, run-now, and delete all work on a phone.
- A queued one-off task can be cancelled from both the table and the phone card.
- Create/edit dialog scrolls fully with the keyboard open.
- Desktop tables unchanged at `md+`/`lg+`.
