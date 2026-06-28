# 05 — Knowledge / Memory Explorer

File: `src/app/dashboard/knowledge/page.tsx` (nav label "Knowledge", component
`MemoryPage`) · Severity: **High**

Browse + semantic-search the vector memory (Qdrant). Scope filter, search bar, a
data **table**, and pagination, with a delete-confirm dialog.

## Current state

- Root: `flex flex-col h-full gap-3`.
- Header: `flex items-center justify-between gap-2 flex-wrap shrink-0` — title +
  a button group: scope toggles (All/private/shared) + Refresh.
- Search bar: `flex gap-2` — full-width `Input` + Search button + (in search mode)
  Browse button.
- Table: `flex-1 min-h-0 overflow-auto border rounded-md` wrapping
  `@/components/ui/table` with columns: Score (search mode), Scope, Author,
  Timestamp, Text, Actions(Delete). Header is `sticky top-0`.
- Pagination: `flex justify-end gap-2` Previous/Next (browse mode only).

## Responsive issues

1. **P3 — table does not reflow.** Six columns of `font-mono text-xs` on a 360px
   phone overflow horizontally; the row content (especially Text + Timestamp +
   Author) is unreadable. The container scrolls horizontally inside the page which
   is poor UX and easy to miss.
2. The Delete action is a real `Button variant="destructive"` in the last
   cell — fine for desktop but tiny and far-right on a horizontally scrolled table.
3. Scope toggles + Refresh wrap acceptably (header already `flex-wrap`).

## Build tasks

1. **Responsive rows (P3):**
   - `md+`: keep the existing `<table>` exactly.
   - `< md`: render a `md:hidden` card list. Each card:
     - Top line: Scope badge + Author + (search mode) Score, `flex-wrap`.
     - Middle: the Text (`whitespace-pre-wrap break-words`, clamp to ~4 lines with
       a "more" toggle or `line-clamp-4`).
     - Bottom line: Timestamp (muted) + a `Delete` button (full-width or right
       aligned, ≥ 36px tall).
   - Drive both views from the same `displayPoints` array; factor a
     `MemoryRowData` mapping so table cells and card fields share formatting
     (`formatTs`, score `toFixed(3)`).
2. **Search bar at < 360px:** `Input` is `flex-1` already; ensure the Search +
   Browse buttons don't wrap under awkwardly — acceptable as-is, but set the row to
   `flex-wrap` so Browse drops below if needed.
3. **Pagination:** fine; keep `justify-end`.
4. Keep the delete-confirm `Dialog` (already responsive `sm:max-w-md`).

## Acceptance criteria

- At 360px, memory entries are readable as stacked cards with no horizontal scroll;
  Scope, Author, Timestamp, Text, and Delete are all visible per entry.
- Search and scope filtering work and update the card list.
- Delete confirm flow works from a card.
- Desktop table unchanged at `md+`.
