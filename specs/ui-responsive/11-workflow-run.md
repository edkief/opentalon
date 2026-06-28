# 11 — Workflow Run View

File: `src/app/dashboard/workflows/[id]/runs/[runId]/page.tsx` · Severity: **High**

Read-only run inspector: status toolbar, React Flow canvas (node statuses live via
SSE), and a right panel with selected-node detail + a list of all nodes. Includes
HITL Approve/Deny actions.

## Current state

- Root: `flex flex-col h-full`.
- Toolbar: `flex items-center gap-3 px-4 py-2 border-b` — Back, workflow name +
  short run id, `RunStatusBadge`, conditional **Cancel**, Refresh. No wrap.
- Body: `flex flex-1 overflow-hidden` — canvas `flex-1` + **right panel
  `w-64 … border-l`** that is **always visible** (no breakpoint guard).
- Right panel: `NodeDetail` (input/output/console `<pre>` blocks, HITL
  Approve/Deny) + an "All Nodes" list at the bottom.

## Responsive issues

1. **P5 — permanent `w-64` panel.** Unlike the editor, the right panel here has no
   `hidden`/conditional class — it is **always** beside the canvas. On a 360px
   phone the canvas is ~96px wide and the run graph is unreadable.
2. **P1 — toolbar** name + badge + Cancel + Refresh; `paused` badge text is long
   ("paused — awaiting approval"). Can overflow on phones.
3. **HITL Approve/Deny** live inside the right panel `NodeDetail`. If the panel is
   unusable on phones, a user **cannot approve/deny a paused run from a phone** —
   this is a functional blocker, not just cosmetic.

## Build tasks

1. **Right panel → responsive (P5), mirror Turn Viewer:**
   - `md+`: keep `w-64` side panel (consider `lg:w-72`).
   - `< md`: canvas full width. Put the "All Nodes" list into a `md:hidden`
     collapsible strip or a sheet trigger; when a node is selected (tap in canvas
     or from the node list), open `NodeDetail` in a `md:hidden` bottom sheet
     (`fixed inset-x-0 bottom-0 max-h-[70%] overflow-y-auto`) with a close button.
   - Ensure **HITL Approve/Deny buttons render in the mobile sheet** so paused runs
     can be resolved on a phone.
2. **Toolbar (P1):** add `flex-wrap gap-2`; shorten the `paused` badge on phones
   (icon + "paused", drop "— awaiting approval" below `sm`, keep full on `md+`);
   keep Cancel + Refresh reachable.
3. **`<pre>` output/console blocks** already `overflow-auto max-h-*
   whitespace-pre-wrap` — fine inside the sheet.

## Acceptance criteria

- At 360px: the run graph is visible full-width; tapping a node opens a bottom
  sheet with its input/output/console.
- A **paused (HITL) run can be approved or denied from a phone**.
- Cancel/Refresh reachable; status badge legible.
- Desktop layout unchanged at `md+`.
