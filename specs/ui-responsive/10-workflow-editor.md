# 10 — Workflow Editor

File: `src/app/dashboard/workflows/[id]/page.tsx` · Severity: **High**

React Flow canvas editor: top toolbar, left node palette, centre canvas + problems
panel, right config/run-history panel. The most layout-dense screen.

## Current state

- Root: `WorkflowProvider > flex flex-col h-full`.
- **Toolbar** (`flex items-center gap-2 px-4 py-2 border-b`): Back, editable name
  (`flex-1 min-w-0 truncate`) + description, then **Runs**, **Export**, **Save**,
  **Run** — four labelled buttons, **no wrap**.
- **Mobile palette**: `lg:hidden flex items-center gap-1 overflow-x-auto …` — a
  horizontal scroller of node-type buttons. Good — already built.
- **Left palette**: `w-40 … hidden lg:flex` — desktop only. Good.
- **Centre**: `flex-1` canvas (`WorkflowCanvas`) + a status bar (errors/warnings) +
  collapsible Problems panel (`max-h-48`).
- **Right panel**: `w-64 … ${selectedNode ? 'flex' : 'hidden lg:flex'}` — shows the
  `ConfigPanel` when a node is selected; also hosts collapsible Run History. The
  `code` node config embeds a 200px Monaco editor.

## Responsive issues

1. **P1 — toolbar overflow (main issue).** Back + name + 4 text buttons in one
   non-wrapping `px-4` row. On a 360px phone the buttons overflow horizontally /
   clip. Name is `flex-1 min-w-0 truncate` so it yields, but four labelled buttons
   (`Runs`, `Export`, `Save`, `Run`) still exceed the width.
2. **P5 — right config panel is `w-64` and shows whenever a node is selected**,
   side-by-side with the canvas. On a 360px phone, selecting a node leaves the
   canvas ~96px wide — unusable. It is not a bottom sheet like the Turn Viewer.
3. **React Flow touch:** panning/zooming via touch works by default, but node drag
   vs. canvas pan can conflict; verify `panOnDrag`/`zoomOnPinch` are enabled and
   nodes are draggable without hijacking page scroll.
4. Problems panel `max-h-48` is fine.

## Build tasks

1. **Toolbar (P1):**
   - Collapse `Runs`/`Export` labels to icon-only on phones
     (`<span className="hidden md:inline">`), keep their icons.
   - Keep **Save** and **Run** but icon + label only `sm:inline`; on the smallest
     screens show icons only.
   - Optionally move `Export` (and the desktop "Runs" toggle, since Run History is
     also in the right panel) into a `⋯` overflow menu `< md`.
   - Add `flex-wrap` as a last-resort guard so nothing clips.
2. **Right panel → mobile bottom sheet (P5):** mirror the Turn Viewer pattern:
   - `md+`: keep the `w-64` (consider `lg:w-72`) side panel.
   - `< md`: when `selectedNode` is set, render the `ConfigPanel` in a
     `md:hidden fixed inset-x-0 bottom-0 z-30 max-h-[70%] overflow-y-auto rounded-t-xl
     border-t shadow-2xl` sheet with a header (node label + close ✕). Reuse the
     existing `ConfigPanel` component unchanged inside the sheet.
   - The embedded `code` Monaco (200px) is acceptable inside the sheet; ensure the
     sheet scrolls.
   - Run History: on phones move its disclosure into the same sheet or a separate
     "Runs" overflow action (the toolbar `Runs` button can open a runs sheet).
3. **Keep the mobile palette** (`lg:hidden` horizontal scroller) — it already
   solves node-adding on phones.
4. **Unsaved-guard / rename** logic is layout-agnostic — no change.

## Acceptance criteria

- At 360px: toolbar fits one row (icons) without clipping; Save and Run reachable.
- Selecting a node opens a bottom sheet with the full node config; the canvas stays
  usable (full width) when no node is selected.
- Nodes can be added (mobile palette), positioned, connected, configured, and the
  workflow saved + run entirely on a phone.
- Desktop three-pane layout unchanged at `lg+`.
