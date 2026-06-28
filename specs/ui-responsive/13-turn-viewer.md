# 13 — Turn Viewer

File: `src/app/dashboard/turns/[turnId]/page.tsx` · Severity: **Reference (already
responsive)**

Deep-dive of a single agent turn: React Flow graph of steps/specialists/tools with
an inspector panel. **This screen is the reference implementation** for the
responsive two-pane pattern (P5) the other canvas screens should copy.

## Current state — what it does right

- Toolbar: `flex items-center gap-3 … flex-wrap` — back, "Turn" + short id, optional
  meta (`hidden sm:inline` / `hidden md:inline` to drop low-priority text on small
  screens), Expand/Collapse all, Refresh. Progressive disclosure done correctly.
- Inspector is dual-rendered:
  - **Desktop:** `hidden md:block w-80 lg:w-96 border-l overflow-y-auto` side panel.
  - **Mobile:** `md:hidden absolute inset-x-0 bottom-0 z-20 max-h-[65%] … rounded-t-xl
    border-t shadow-2xl` **bottom sheet**, only when a node is selected, with a
    header (`Details` + close ✕) and `overflow-y-auto overscroll-contain` body.
- Canvas is `flex-1 min-w-0`, full width on phones.
- Esc clears selection; SSE live-refetch is layout-agnostic.

## Responsive issues

- None significant. Minor: the meta string ("N steps · N tool calls · N
  specialists") is `hidden md:inline` — phone users lose this summary. Optional:
  surface a compact version (e.g. just the counts as small badges) on phones.

## Build tasks

1. **No required changes.** Treat as the canonical pattern.
2. (Optional) Add a compact counts badge row visible on phones.
3. **Reuse this pattern** when implementing specs 10 (Workflow Editor) and 11
   (Workflow Run) — same desktop-panel / mobile-bottom-sheet structure, same class
   recipe.

## Acceptance criteria

- Remains fully usable at 360px (already verified by design): canvas full-width,
  node tap opens bottom sheet, close works, no horizontal scroll.
