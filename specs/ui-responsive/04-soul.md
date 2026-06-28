# 04 — Soul Editor

File: `src/app/dashboard/soul/page.tsx` · Severity: **Medium**

MDEditor for `SOUL.md` plus a **Snapshots** sidebar with Snapshot/Restore.

## Current state

- Root: `flex flex-col md:flex-row h-full gap-4` (stacks on phones — good).
- Editor column: `flex flex-col flex-1 gap-4 min-w-0`; header
  `flex items-center justify-between` with title + Saved/Failed + **Snapshot** +
  **Save**. Editor wrapper `flex-1 overflow-auto min-h-[300px] md:min-h-[400px]`.
- Snapshots sidebar: `aside className="hidden md:flex w-56 …"` — list of snapshot
  cards each with a Restore button; count badge.
- Restore confirmation `Dialog`.

## Responsive issues

1. **P2 — Snapshots sidebar hidden on mobile.** `hidden md:flex` means phone users
   cannot view, create-context, or restore snapshots. The **Snapshot** button in
   the header still works (creates one) but the list and Restore are unreachable.
2. **P1 (minor)** — header has two buttons + status text; tight but fits with
   `flex-wrap`.

## Build tasks

1. **Mobile snapshots access (P2):**
   - Keep the desktop `aside` as-is for `md+`.
   - On phones, add a header button `Snapshots (N)` (`md:hidden`) that opens a
     bottom `Sheet`/`Dialog` rendering the **same** snapshot card list (extract the
     list JSX into a `<SnapshotList snapshots onRestore busy />` component shared by
     the aside and the sheet).
   - Restore from within the sheet should open the existing confirm `Dialog`.
2. **Header (P1):** add `flex-wrap gap-2`; on phones collapse "Snapshot" label to
   an icon if space is tight, keep "Save" as the visible primary.
3. Editor already has `min-h-[300px]` — keep.

## Acceptance criteria

- At 360px a user can create, view, and restore snapshots without a desktop.
- Editor + Save usable; no horizontal scroll.
- Desktop layout unchanged.
