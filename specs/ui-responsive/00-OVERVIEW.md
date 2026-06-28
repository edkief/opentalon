# UI Responsive Audit — Overview & Conventions

This folder holds one build spec per dashboard screen. Each spec follows the same
shape: **Current state → Responsive issues → Build tasks → Acceptance criteria**.
Read this overview first — it defines the shared shell, breakpoints, and the
recurring cross-screen patterns the per-screen specs reference by name.

## Audit scope

All screens under `src/app/dashboard/`. The shared shell
(`layout.tsx`, `_components/SidebarNav.tsx`, `_components/ConfigStatusBanner.tsx`)
is already mobile-aware (hamburger + slide-in drawer, 44px touch targets, focus
trap, Esc-to-close). The shell is **not** a problem area. Most issues live in the
per-screen content.

## Breakpoints (Tailwind defaults — keep these)

| Token | Min width | Use for |
|-------|-----------|---------|
| (base) | 0 | Phone portrait — the default, design here first |
| `sm` | 640px | Large phone / phone landscape |
| `md` | 768px | Tablet — sidebar becomes permanent, two-pane layouts unlock |
| `lg` | 1024px | Small laptop — palettes/sidebars that were drawers become permanent |
| `xl` | 1280px | Desktop — optional density |

**Primary target for this work: 360–414px portrait phones.** Verify at 360px.

## Recurring patterns (referenced by per-screen specs)

These problems appear on multiple screens. Fix them the same way everywhere so the
dashboard feels consistent.

### P1 — Header action overflow
**Symptom:** `<div className="flex items-center justify-between">` with a title on
the left and 3–5 buttons on the right. On phones the buttons either overflow the
viewport or crush the title.
**Affected:** Thought Stream (4 buttons + chat select), Workflow Editor (6 toolbar
items), Workflows list, Agents (tabs + Save), Config/Secrets/Soul (Snapshot+Save).
**Fix pattern:**
- Wrap the header row: add `flex-wrap gap-2` to the container.
- Collapse low-priority text buttons into icon-only on phones
  (`<span className="hidden sm:inline">Label</span>` beside the icon), OR
- Move secondary actions (Verbose, Collapse tools, Clear, Snapshot) into a
  `⋯` overflow menu (DropdownMenu) shown only below `sm`.
- Keep the **one** primary action (Save / Send / Run) always visible.

### P2 — Snapshots sidebar hidden on mobile
**Symptom:** `<aside className="hidden md:flex w-56 …">` for the Snapshots panel.
Below `md` the snapshot list — and the only way to create/restore a snapshot — is
completely inaccessible.
**Affected:** Config, Secrets, Soul, Agents (Soul/Identity tabs).
**Fix pattern:** Replace the hard `hidden md:flex` with a disclosure. On phones
render a "Snapshots (N)" button in the header that opens a `Sheet`/`Dialog`
(bottom sheet) containing the same list and the Snapshot/Restore actions. Reuse the
existing list markup inside the sheet so there is one source of truth.

### P3 — Data tables don't reflow
**Symptom:** `@/components/ui/table` used directly; on phones the table either
overflows with a horizontal scrollbar or columns get hidden with
`hidden md:table-cell` (dropping information entirely).
**Affected:** Knowledge (Memory Explorer), Shared Files, Scheduled Tasks.
**Fix pattern:** Below `md`, render each row as a stacked **card** instead of a
table row: primary field as the card title, secondary fields as labelled lines,
actions as a row of icon buttons. Keep the `<table>` for `md+`. Extract a small
`<ResponsiveRows>` helper or duplicate the map with a `md:hidden` card list +
`hidden md:block` table. Never hide an action (delete/run/edit) behind a breakpoint.

### P4 — Double padding / fixed max-width
**Symptom:** A page adds its own `p-6` (and sometimes `max-w-5xl mx-auto`) even
though `layout.tsx <main>` already applies `p-4 md:p-6`. Net result on phones is
~40px of horizontal padding eating scarce width.
**Affected:** Shared Files (`p-6 max-w-5xl`), Workflows list (`p-6 max-w-5xl mx-auto`).
**Fix pattern:** Drop the page-level `p-6`; rely on `<main>` padding. Keep
`max-w-*` for readability on desktop but it should not add padding on phones.

### P5 — Two-pane (canvas/editor + side panel) on phones
**Symptom:** A permanent `w-64`/`w-80` side panel sits next to a React Flow canvas
or Monaco editor. On a 360px phone the panel consumes most of the width and the
canvas is unusable.
**Affected:** Workflow Editor, Workflow Run view, Turn Viewer (already fixed —
use it as the reference implementation).
**Fix pattern:** Follow the Turn Viewer (`turns/[turnId]/page.tsx`): canvas is
full-bleed; the inspector is a **desktop side panel** (`hidden md:block w-80`) and a
**mobile bottom sheet** (`md:hidden fixed inset-x-0 bottom-0 max-h-[65%]`) that only
appears when a node is selected, with a close button.

### P6 — Deeply-indented trees overflow
**Symptom:** `style={{ marginLeft: depth * 20 }}` (Orchestration) or
`paddingLeft: depth*12` (Skills file tree) pushes content off-screen on phones.
**Fix pattern:** Cap indent on small screens (e.g. `Math.min(depth, 3) * 12`), and
let the indented container scroll horizontally (`overflow-x-auto`) rather than
forcing the whole page wide.

### P7 — Code/JSON `<pre>` blocks force horizontal scroll
**Symptom:** `whitespace-pre-wrap break-all` is mostly fine, but raw
`JSON.stringify(..., null, 2)` and Monaco editors set fixed heights that are too
tall on phones.
**Fix pattern:** Already mostly handled via `break-all`/`wordWrap: 'on'`. Ensure
every embedded Monaco/MDEditor has a sensible `min-h` and lives in a
`flex-1 overflow-auto` parent (most already do). Verify editor toolbars are
reachable (MDEditor toolbar wraps poorly < 360px).

## Cross-cutting conventions for all new work

- **Touch targets ≥ 44×44px** for any primary tap target on phones. Icon-only
  ghost buttons currently use `h-7 w-7` (28px) — acceptable for dense desktop
  tables but bump to `h-9 w-9` (or add padding) when they are the only action on a
  mobile card.
- **No hover-only affordances on touch.** Several screens reveal actions with
  `opacity-0 group-hover:opacity-100` (Agents list ★/✎/✕, Thought Stream inspect
  link, Skills delete, Workflows row actions). Touch devices have no hover — make
  these `opacity-100` (or `sm:opacity-0 sm:group-hover:opacity-100`) so they're
  always visible on phones. Workflows already does this with `opacity-0 md:opacity-100`.
- **Selects/inputs**: native `<select>`/`<input>` already scale; just ensure they
  are `w-full` inside stacked mobile layouts rather than fixed widths.
- **Dialogs**: Shadcn `DialogContent` is centered and `sm:max-w-*`. On phones it
  defaults to near-full-width which is fine; verify long forms (Scheduled Tasks
  create, Onboarding) scroll inside the dialog (`max-h-[90vh] overflow-y-auto`).
- **Charts** (Metrics): already wrapped in `ResponsiveContainer` + `overflow-x-auto`.
  No change needed beyond verifying the KPI grid (`grid-cols-2`) at 360px.

## Per-screen specs index

| # | Screen | File | Severity |
|---|--------|------|----------|
| 01 | Thought Stream (home) | `01-thought-stream.md` | High |
| 02 | Core Memory | `02-core-memory.md` | Low |
| 03 | Identity | `03-identity.md` | Low |
| 04 | Soul | `04-soul.md` | Medium |
| 05 | Knowledge / Memory Explorer | `05-knowledge.md` | High |
| 06 | Preferences (config) | `06-config.md` | Medium |
| 07 | Secrets | `07-secrets.md` | Medium |
| 08 | Skills | `08-skills.md` | Medium |
| 09 | Workflows (list) | `09-workflows-list.md` | Medium |
| 10 | Workflow Editor | `10-workflow-editor.md` | High |
| 11 | Workflow Run view | `11-workflow-run.md` | High |
| 12 | Orchestration | `12-orchestration.md` | Medium |
| 13 | Turn Viewer | `13-turn-viewer.md` | Reference (done) |
| 14 | Metrics | `14-metrics.md` | Low |
| 15 | Scheduled Tasks | `15-scheduled-tasks.md` | High |
| 16 | Shared Files | `16-shared-files.md` | Medium |
| 17 | Logs | `17-logs.md` | Low |
| 18 | Agents | `18-agents.md` | High |
| 19 | Onboarding | `19-onboarding.md` | Low |
| 20 | Login | `20-login.md` | Done |

Severity = how much phone usability is currently broken, not implementation size.
