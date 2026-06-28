# 18 — Agents

File: `src/app/dashboard/agents/page.tsx` (1437 lines) · Severity: **High**

The densest config screen: a left agent list and a right editor with **nine tabs**
(Soul, Identity, Models, Tools, RAG, Heartbeat, Sub-agents, Skills, Workflows),
each with its own form. Soul/Identity tabs also include an MDEditor + Snapshots
sidebar.

## Current state

- Root: `flex flex-col h-full gap-0 overflow-hidden` with an `h1` then
  `flex flex-1 flex-col md:flex-row` (stacks on phones — good).
- **Left list:** `w-full md:w-48 … border-b md:border-r … max-h-40 md:max-h-none
  overflow-y-auto` — short scrolling panel above the editor on phones. New-agent
  form inline. Each agent row reveals ★ (default) / ✎ (rename) / ✕ (delete) on
  `group-hover:opacity-100` (★ is solid when default).
- **Editor header:** `flex items-center justify-between` containing, on the left,
  `flex items-center gap-2`: agent id + "default" badge + a **`flex gap-1
  flex-wrap` row of all nine tab buttons**; on the right: Saved/Failed + conditional
  **Snapshot** + **Save**.
- **Tab bodies:** Models/Tools/RAG/Heartbeat/Sub-agents/Skills/Workflows are
  `flex flex-col gap-* p-1 flex-1 overflow-y-auto max-w-lg` forms (toggles, selects,
  chip lists) — these stack fine on phones.
- **Soul/Identity body:** `flex flex-1 gap-4` with an MDEditor column + a
  `hidden md:flex w-48` **Snapshots** aside.
- Confirm `Dialog` for restore/delete.

## Responsive issues

1. **P1 (severe) — header is overloaded.** Agent id + default badge + **nine tab
   buttons** + Snapshot + Save are crammed into one `justify-between` row. The tab
   group `flex-wrap`s but, combined with the Save/Snapshot buttons in the same row,
   it produces a tall, tangled header on phones where tabs and actions interleave
   confusingly.
2. **P2 — Snapshots aside hidden on mobile** (`hidden md:flex`) on Soul/Identity
   tabs — no snapshot list/restore on phones (Snapshot button still creates one).
3. **Hover-only row actions** (★/✎/✕) — on touch the rename and delete controls are
   invisible; only the solid ★ on the default agent shows.
4. **`max-h-40` (160px) agent list** on phones is short when there are many agents.

## Build tasks

1. **Separate tabs from actions (P1):**
   - Pull the nine-tab row out of the left `flex items-center gap-2` group into its
     **own full-width row** below the agent-id/Save row.
   - Make the tab row a horizontal scroller on phones:
     `flex gap-1 overflow-x-auto` (no wrap) so tabs are one swipeable strip; keep
     `flex-wrap` only at `md+` if preferred. Each tab `shrink-0`.
   - Header row 1: agent id + default badge (left) · Save (+ Snapshot when
     applicable) (right). Keep `flex-wrap gap-2`.
2. **Mobile snapshots (P2):** reuse the shared `<SnapshotList>` + bottom-sheet
   pattern (see Soul 04 / Config 06). On Soul/Identity tabs, show a `Snapshots (N)`
   button (in header or above the editor) on phones that opens the list + Restore.
3. **Touch-visible row actions (P3):** make ★/✎/✕
   `opacity-100 sm:opacity-0 sm:group-hover:opacity-100`; ensure ≥ 28–32px tap area
   (`p-1`). The destructive ✕ should remain clearly reachable.
4. **Agent list height (P4-ish):** bump phone list to `max-h-56` (or make it
   collapsible) so more agents are visible; keep `md:max-h-none`.
5. **Tab form widths:** the `max-w-lg` forms are fine; ensure selects/inputs are
   `w-full` within them on phones (most already are).

## Acceptance criteria

- At 360px: the nine tabs are a clean, swipeable strip distinct from the
  Save/Snapshot actions; switching tabs is obvious.
- Snapshots can be viewed/restored on a phone (Soul/Identity).
- Rename and delete of an agent work via touch (no hover).
- Every tab's form is fully usable on a phone (toggles, chip lists, selects,
  editors); Save works per tab.
- Desktop two-pane layout unchanged at `md+`.
