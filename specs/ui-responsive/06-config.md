# 06 — Preferences (config.yaml)

File: `src/app/dashboard/config/page.tsx` · Severity: **Medium**

Monaco YAML editor for `config.yaml` with live schema validation, Ctrl/Cmd-S save,
and a **Snapshots** sidebar. Twin of Secrets (07).

## Current state

- Root: `flex flex-col md:flex-row h-full gap-4` (stacks on phones — good).
- Editor column `flex flex-col flex-1 gap-3 min-w-0`; header
  `flex items-center justify-between` (title + Saved/Failed/"Unsaved changes" +
  **Snapshot** + **Save**).
- Validation banner (yellow) under the header.
- Editor: `flex-1 border rounded-md overflow-hidden min-h-[300px] md:min-h-[400px]`
  with `MonacoEditor` (`wordWrap: 'on'`, no minimap).
- Snapshots `aside className="hidden md:flex w-56 …"`; restore confirm `Dialog`.

## Responsive issues

1. **P2 — Snapshots sidebar hidden below `md`.** Phone users can press Snapshot
   (creates one) but cannot see the list or Restore.
2. **P1 (minor)** — header Snapshot + Save + status text; tight, `flex-wrap` needed.
3. **Monaco on phones**: usable (pinch-zoom/scroll), but the on-screen keyboard
   plus `min-h-[300px]` can leave little visible code on short viewports. Minor.

## Build tasks

1. **Mobile snapshots (P2):** identical pattern to Soul (04) — extract a shared
   `<SnapshotList>` used by the desktop `aside` and a `md:hidden` bottom-sheet
   opened from a header `Snapshots (N)` button. Restore routes through the existing
   confirm `Dialog`. Config and Secrets should share this component.
2. **Header (P1):** add `flex-wrap gap-2`; keep Save primary, Snapshot secondary.
3. Keep the validation banner full-width above the editor (already correct).

## Acceptance criteria

- Snapshots viewable/restorable on a phone at 360px.
- Editing + save (button and Cmd/Ctrl-S) works; validation banner visible.
- No horizontal page scroll; desktop unchanged.
