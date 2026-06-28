# 09 — Workflows (list)

File: `src/app/dashboard/workflows/page.tsx` · Severity: **Medium**

List of workflow definitions with create/import, per-row run/export/archive, and
run/create dialogs.

## Current state

- Root: `flex flex-col gap-6 p-6 max-w-5xl mx-auto`.
- Header: `flex items-center justify-between` — icon + title + subtitle on the left;
  Refresh / Import / **New Workflow** on the right.
- List: each item is a `Link` card `flex items-center gap-4 p-4 …` with icon, name +
  status badge + description + "Updated …", a run-status icon, and a row-action
  group (Run / Export / Archive) that is `opacity-0 md:opacity-100
  group-hover:opacity-100`.
- Run and Create dialogs.

## Responsive issues

1. **P4 — double padding + fixed width.** `p-6 max-w-5xl mx-auto` on top of
   `<main>`'s `p-4 md:p-6` wastes ~40px horizontal on phones.
2. **P1 — header actions.** Three buttons + a two-line title block. `justify-between`
   with no wrap; "New Workflow" has a text label. On 360px the title and buttons
   compete; buttons may overflow.
3. **Row actions** correctly use `opacity-0 md:opacity-100` so they ARE visible on
   phones (`md:opacity-100`) — good, no hover problem. But three icon buttons +
   name + badges in a single `flex` row get tight; the description/Updated lines
   already `truncate`.

## Build tasks

1. **Remove double padding (P4):** drop `p-6`; keep `max-w-5xl mx-auto` for desktop
   centring (it adds no padding at narrow widths). Result: `flex flex-col gap-6
   max-w-5xl mx-auto`.
2. **Header (P1):** add `flex-wrap gap-2`. On phones, make Refresh/Import icon-only
   (label `hidden sm:inline`) and keep "New Workflow" (or shorten to a `+` icon
   button with `sr-only` label) as the visible primary.
3. **Row card on phones:** allow the action group to wrap below the name/desc block
   at `< sm`: change the card to `flex-wrap` or place actions on their own line
   under the text on phones (`flex-col sm:flex-row`). Keep Run/Export/Archive all
   visible (they already are via `md:opacity-100`; extend to `sm` or always-on).
4. Dialogs already fine.

## Acceptance criteria

- At 360px: full content width used (no double padding); header fits ≤ 2 rows;
  create/import/new reachable.
- Each workflow row shows name, status, and all three actions without horizontal
  scroll.
- Desktop layout visually unchanged.
