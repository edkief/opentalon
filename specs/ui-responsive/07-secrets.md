# 07 — Secrets (secrets.yaml)

File: `src/app/dashboard/secrets/page.tsx` · Severity: **Medium**

Monaco YAML editor for `secrets.yaml`. Identical to Preferences (06) plus a red
credentials warning banner.

## Current state

- Same layout as Config: `flex flex-col md:flex-row h-full gap-4`, editor column +
  `hidden md:flex` Snapshots aside, header with Snapshot/Save, restore `Dialog`.
- Extra: red warning banner ("This file contains credentials…") above the editor.

## Responsive issues

1. **P2 — Snapshots sidebar hidden below `md`** (same as Config).
2. **P1 (minor)** header crowding.
3. Warning + validation banners stack above the editor — they consume vertical
   space on short phones, leaving little editor height. Acceptable but watch the
   combined height.

## Build tasks

1. Apply the **shared `<SnapshotList>` + mobile bottom-sheet** fix from Config (06)
   — same component, same behaviour.
2. Header: `flex-wrap gap-2`.
3. Consider making the red warning banner collapsible/dismissible on phones (it is
   static text that pushes the editor down every visit) — low priority.

## Acceptance criteria

- Snapshots viewable/restorable on a phone; warning banner remains visible.
- Editor usable at 360px; no horizontal scroll; desktop unchanged.
